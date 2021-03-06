var _ = require('underscore');
var moment = require('moment');
var FacebookServer = require('../lib/facebook/facebook-chat');
var ContextProviders = require('../lib/chat-platform/chat-context-factory');
var utils = require('../lib/helpers/utils');
var clc = require('cli-color');
var lcd = require('../lib/helpers/lcd');
var prettyjson = require('prettyjson');
var validators = require('../lib/helpers/validators');

var when = utils.when;
var warn = clc.yellow;
var green = clc.green;

module.exports = function(RED) {

  // register Slack server
  if (RED.redbot == null) {
    RED.redbot = {};
  }
  if (RED.redbot.platforms == null) {
    RED.redbot.platforms = {};
  }
  RED.redbot.platforms.facebook = FacebookServer;

  var contextProviders = ContextProviders(RED);

  function FacebookBotNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    var environment = this.context().global.environment === 'production' ? 'production' : 'development';
    var isUsed = utils.isUsed(RED, node.id);
    var startNode = utils.isUsedInEnvironment(RED, node.id, environment);
    var facebookConfigs = RED.settings.functionGlobalContext.get('facebook') || {};

    this.botname = n.botname;
    this.store = n.store;
    this.log = n.log;
    this.debug = n.debug;
    this.usernames = n.usernames != null ? n.usernames.split(',') : [];

    if (!isUsed) {
      // silently exit, this node is not used
      return;
    }
    // exit if the node is not meant to be started in this environment
    if (!startNode) {
      // eslint-disable-next-line no-console
      console.log(warn('Facebook Messenger Bot ' + this.botname + ' will NOT be launched, environment is ' + environment));
      return;
    }
    // eslint-disable-next-line no-console
    console.log(green('Facebook Messenger Bot ' + this.botname + ' will be launched, environment is ' + environment));

    // get the context storage node
    var contextStorageNode = RED.nodes.getNode(this.store);
    // build the configuration object
    var botConfiguration = {
      authorizedUsernames: node.usernames,
      token: node.credentials != null && node.credentials.token != null ? node.credentials.token.trim() : null,
      verifyToken: node.credentials != null && node.credentials.verify_token != null ? node.credentials.verify_token.trim() : null,
      appSecret: node.credentials != null && node.credentials.app_secret != null ? node.credentials.app_secret.trim() : null,
      logfile: node.log,
      debug: node.debug,
      contextProvider: contextStorageNode != null ? contextStorageNode.contextStorage : null,
      contextParams: contextStorageNode != null ? contextStorageNode.contextParams : null
    };
    // check if there's a valid configuration in global settings
    if (facebookConfigs[node.botname] != null) {
      var validation = validators.platform.facebook(facebookConfigs[node.botname]);
      if (validation != null) {
        /* eslint-disable no-console */
        console.log('');
        console.log(lcd.error('Found a Facebook Messenger configuration in settings.js "' + node.botname + '", but it\'s invalid.'));
        console.log(lcd.grey('Errors:'));
        console.log(prettyjson.render(validation));
        console.log('');
        return;
      } else {
        console.log('');
        console.log(lcd.grey('Found a valid Facebook Messenger configuration in settings.js: "' + node.botname + '":'));
        console.log(prettyjson.render(facebookConfigs[node.botname]));
        console.log('');
        /* eslint-enable no-console */
        botConfiguration = facebookConfigs[node.botname];
      }
    }
    // check if context node
    if (botConfiguration.contextProvider == null) {
      // eslint-disable-next-line no-console
      console.log(lcd.warn('No context provider specified for chatbot ' + node.botname + '. Defaulting to "memory"'));
      botConfiguration.contextProvider = 'memory';
      botConfiguration.contextParams = {};
    }
    // if chat is not already there and there's a token
    if (node.chat == null && botConfiguration.token != null) {
      // check if provider exisst
      if (!contextProviders.hasProvider(botConfiguration.contextProvider)) {
        node.error('Error creating chatbot ' + this.botname + '. The context provider '
          + botConfiguration.contextProvider + ' doesn\'t exist.');
        return;
      }
      // create a factory for the context provider
      node.contextProvider = contextProviders.getProvider(botConfiguration.contextProvider, botConfiguration.contextParams);
      // try to start the servers
      try {
        node.contextProvider.start();
        node.chat = FacebookServer.createServer({
          authorizedUsernames: botConfiguration.usernames,
          token: botConfiguration.token,
          verifyToken: botConfiguration.verify_token,
          appSecret: botConfiguration.app_secret,
          contextProvider: node.contextProvider,
          logfile: botConfiguration.log,
          debug: botConfiguration.debug,
          RED: RED
        });
        node.chat.start();
        // handle error on sl6teack chat server
        node.chat.on('error', function(error) {
          node.error(error);
        });
        node.chat.on('warning', function(warning) {
          node.warn(warning);
        });
      } catch(e) {
        node.error(e);
      }
    }

    this.on('close', function (done) {
      node.chat.stop()
        .then(function() {
          return node.contextProvider.stop();
        })
        .then(function() {
          node.chat = null;
          node.contextProvider = null;
          done();
        });
    });
  }
  RED.nodes.registerType('chatbot-facebook-node', FacebookBotNode, {
    credentials: {
      token: {
        type: 'text'
      },
      app_secret: {
        type: 'text'
      },
      verify_token: {
        type: 'text'
      }
    }
  });

  function FacebookInNode(config) {

    RED.nodes.createNode(this, config);
    var node = this;
    var global = this.context().global;
    var environment = global.environment === 'production' ? 'production' : 'development';
    var nodeGlobalKey = null;

    this.bot = config.bot;
    this.botProduction = config.botProduction;
    this.config = RED.nodes.getNode(environment === 'production' ? this.botProduction : this.bot);

    if (this.config) {
      this.status({fill: 'red', shape: 'ring', text: 'disconnected'});
      node.chat = this.config.chat;
      if (node.chat) {
        this.status({fill: 'green', shape: 'ring', text: 'connected'});
        nodeGlobalKey = 'facebook_master_' + this.config.id.replace('.','_');
        var isMaster = false;
        if (global.get(nodeGlobalKey) == null) {
          isMaster = true;
          global.set(nodeGlobalKey, node.id);
        }
        node.chat.on('message', function (message) {
          var context = message.chat();
          // if a conversation is going on, go straight to the conversation node, otherwise if authorized
          // then first pin, if not second pin
          when(context.get('currentConversationNode'))
            .then(function(currentConversationNode) {
              if (isMaster && currentConversationNode != null) {
                // void the current conversation
                when(context.remove('currentConversationNode'))
                  .then(function() {
                    // emit message directly the node where the conversation stopped
                    RED.events.emit('node:' + currentConversationNode, message);
                  });
              } else {
                node.send(message);
              }
            });
        });
      } else {
        node.warn('Missing or incomplete configuration in Facebook Receiver');
      }
    } else {
      node.warn('Missing configuration in Facebook Receiver');
    }

    this.on('close', function (done) {
      node.context().global.set(nodeGlobalKey, null);
      if (node.chat != null) {
        node.chat.off('message');
      }
      done();
    });
  }
  RED.nodes.registerType('chatbot-facebook-receive', FacebookInNode);

  function FacebookOutNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    var global = this.context().global;
    var environment = global.environment === 'production' ? 'production' : 'development';

    this.bot = config.bot;
    this.botProduction = config.botProduction;
    this.track = config.track;
    this.config = RED.nodes.getNode(environment === 'production' ? this.botProduction : this.bot);

    this.config = RED.nodes.getNode(this.bot);
    if (this.config) {
      this.status({fill: 'red', shape: 'ring', text: 'disconnected'});
      node.chat = this.config.chat;
      if (node.chat) {
        this.status({fill: 'green', shape: 'ring', text: 'connected'});
      } else {
        node.warn('Missing or incomplete configuration in Facebook Receiver');
      }
    } else {
      node.warn('Missing configuration in Facebook Receiver');
    }

    // relay message
    var handler = function(msg) {
      node.send(msg);
    };
    RED.events.on('node:' + config.id, handler);

    // cleanup on close
    this.on('close',function() {
      RED.events.removeListener('node:' + config.id, handler);
    });

    this.on('input', function (message) {
      var context = _.isFunction(message.chat) ? message.chat() : null;
      var stack = when(true);
      // check if this node has some wirings in the follow up pin, in that case
      // the next message should be redirected here
      if (context != null && node.track && !_.isEmpty(node.wires[0])) {
        stack = stack.then(function() {
          return when(context.set({
            currentConversationNode: node.id,
            currentConversationNode_at: moment()
          }));
        });
      }
      // finally send out
      stack.then(function() {
        node.chat.send(message);
      });
    });
  }
  RED.nodes.registerType('chatbot-facebook-send', FacebookOutNode);

};
