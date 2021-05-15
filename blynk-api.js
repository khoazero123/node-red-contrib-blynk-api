/**
 * Copyright 2013,2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
  'use strict';
  var debug = require('debug')('blynk-api')
  var WebSocket = require('ws');
  var inspect = require('util').inspect;
  var DataView = require('buffer-dataview');
  var request = require('request');

  //BLYNK STUFF
  function messageToDebugString(bufArray) {
    var dataview = new DataView(bufArray);
    var cmdString = getStringByCommandCode(dataview.getInt8(0));
    var msgId = dataview.getUint16(1);
    var responseCode = getStatusByCode(dataview.getUint16(3));
    return (
      'Command : ' +
      cmdString +
      ', msgId : ' +
      msgId +
      ', responseCode : ' +
      responseCode
    );
  }

  function decodeCommand(bufArray) {
    var dataview = new DataView(bufArray);
    var command = {};
    command.type = dataview.getInt8(0);
    command.typeString = getStringByCommandCode(dataview.getInt8(0));
    command.msgId = dataview.getUint16(1);

    if (command.type == MsgType.HARDWARE) {
      command.len = dataview.getUint16(3);

      command.body = '';
      for (var i = 0, offset = 5; i < command.len; i++, offset++) {
        //dataview.setInt8(offset, cmdBody.charCodeAt(i));
        command.body += String.fromCharCode(dataview.getInt8(offset));
      }
      if (command.body != '') {
        var values = command.body.split('\0');
        if (values.length > 1) {
          command.operation = values[0];
          command.pin = values[1];
          if (values.length > 2) {
            command.value = values[2];
            //we have an array of commands, return array as well
            command.array = values.slice(2, values.length);
          }
        }
      }
    } else {
      command.status = dataview.getUint16(3);
    }
    return command;
  }

  //send
  //create message
  //- get command by string
  //- build blynk message
  //send

  /*
    function send(socket, data) {
        if (socket.readyState == WebSocket.OPEN) {
            var commandAndBody = data.split(" ");
            var message = createMessage(commandAndBody);
            socket.send(message);
        } else {
            debug("The socket is not open.");
        }
    }
    
    function createMessage(commandAndBody) {
        var cmdString = commandAndBody[0];
        var cmdBody = commandAndBody.length > 1 ? commandAndBody.slice(1).join('\0') : null;
        var cmd = getCommandByString(cmdString);
        return buildBlynkMessage(cmd, 1, cmdBody);
    }
    */
  function encodeCommand(command, msgId, body) {
    var BLYNK_HEADER_SIZE = 5;
    var bodyLength = body ? body.length : 0;
    var bufArray = Buffer.alloc(BLYNK_HEADER_SIZE + bodyLength);
    var dataview = new DataView(bufArray);
    dataview.setInt8(0, command);
    dataview.setInt16(1, msgId);
    dataview.setInt16(3, bodyLength);
    if (bodyLength > 0) {
      //todo optimize. should be better way
      var buf = new ArrayBuffer(bodyLength); // 2 bytes for each char
      var bufView = new Uint8Array(buf);
      for (var i = 0, offset = 5; i < body.length; i++, offset += 1) {
        dataview.setInt8(offset, body.charCodeAt(i));
      }
    }
    return new Uint8Array(bufArray);
  }

  var MsgType = {
    RESPONSE: 0,
    LOGIN: 2,
    PING: 6,
    TWEET: 12,
    EMAIL: 13,
    NOTIFY: 14,
    BRIDGE: 15,
    HW_SYNC: 16,
    HW_INFO: 17,
    HARDWARE: 20
  };

  var MsgStatus = {
    OK: 200,
    ILLEGAL_COMMAND: 2,
    NO_ACTIVE_DASHBOARD: 8,
    INVALID_TOKEN: 9,
    ILLEGAL_COMMAND_BODY: 11
  };

  function getCommandByString(cmdString) {
    switch (cmdString) {
      case 'ping':
        return MsgType.PING;
      case 'login':
        return MsgType.LOGIN;
      case 'hardware':
        return MsgType.HARDWARE;
    }
  }

  function getStringByCommandCode(cmd) {
    switch (cmd) {
      case 0:
        return 'RESPONSE';
      case 20:
        return 'HARDWARE';
    }
  }

  function getStatusByCode(statusCode) {
    switch (statusCode) {
      case 200:
        return 'OK';
      case 2:
        return 'ILLEGAL_COMMAND';
      case 8:
        return 'NO_ACTIVE_DASHBOARD';
      case 9:
        return 'INVALID_TOKEN';
      case 11:
        return 'ILLEGAL_COMMAND_BODY';
    }
  }
  
  //END BLYNK STUFF

  // A node red node that sets up a local websocket server
  function BlynkClientNode(n) {
    // Create a RED node
    RED.nodes.createNode(this, n);
    var node = this;

    // Store local copies of the node configuration (as defined in the .html)
    node.path = n.path;
    node.api = n.api;
    node.key = n.key;
    node.wholemsg = n.wholemsg === 'true';

    node._inputNodes = []; // collection of nodes that want to receive events
    node._clients = {};
    // match absolute url
    node.isServer = false;
    node.closing = false;
    node.working = false;

    node.setMaxListeners(100);

    node.pinger = setInterval(function() {
      //only ping if connected and working
      if (node.working) {
        node.ping();
      }
    }, 5000);

    function startconn() {
      // Connect to remote endpoint
      //should not start connection if no server or key
      node.working = false;
      var socket = new WebSocket(node.path);
      //socket.binaryType = 'arraybuffer'; //probably does not work
      node.server = socket; // keep for closing
      handleConnection(socket);
    }

    function handleConnection(/*socket*/ socket) {
      var id = (1 + Math.random() * 4294967295).toString(16);
      socket.setMaxListeners(100);
      socket.on('open', function() {
        node.working = false;
        node.login(node.key);
        node.emit('opened', '');
      });

      socket.on('close', function() {
        node.emit('closed');
        node.working = false;
        if (!node.closing) {
          node.tout = setTimeout(function() {
            startconn();
          }, 5000); // try to reconnect every 5 secs... bit fast ?
        }
      });
      socket.on('message', function(data, flags) {
        //should check if login message OK, then set to working state
        var cmd = decodeCommand(data);
        //first ok is a valid login
        if (
          !node.working &&
          cmd.type == MsgType.RESPONSE &&
          cmd.status == MsgStatus.OK
        ) {
          // debug('valid login, start everything');
          node.working = true;
          node.emit('connected', '');
          //start ping
        } else {
          //should really just send command
          //node.handleEvent(id, socket, 'message', data, flags);
          switch (cmd.type) {
            //MsgType.LOGIN
            case MsgType.RESPONSE:
              //response, ignoring
              break;
            case MsgType.HARDWARE:
              switch (cmd.operation) {
                //input nodes
                case 'dw':
                case 'aw':
                case 'vw':
                  node.handleWriteEvent(cmd);
                  break;
                case 'dr':
                case 'ar':
                case 'vr':
                  node.handleReadEvent(cmd);
                  break;
                case 'pm':
                  /**
                  {
                    type: 20,
                    typeString: 'HARDWARE',
                    msgId: 1,
                    len: 39,
                    body: 'pm\u00000\u0000out\u00001\u0000out\u00002\u0000out\u00003\u0000out\u00004\u0000out\u000023\u0000out',
                    operation: 'pm',
                    pin: '0',
                    value: 'out',
                    array: ['out', '1', 'out', '2', 'out', '3', 'out', '4', 'out', '23', 'out']
                  }
                  */
                  break;
                default:
                  console.log('Unhandled operation', cmd);
              }
              break;
            default:
              console.log('Unhandled response', cmd);
          }
        }
      });
      socket.on('error', function(err) {
        node.emit('erro');
        node.working = false;
        if (!node.closing) {
          node.tout = setTimeout(function() {
            startconn();
          }, 5000); // try to reconnect every 5 secs... bit fast ?
        }
      });
    }

    node.closing = false;
    startconn(); // start outbound connection

    node.on('close', function() {
      // Workaround https://github.com/einaros/ws/pull/253
      // Remove listeners from RED.server

      node.closing = true;
      node.working = false;
      node.server.close();
      if (node.tout) {
        clearTimeout(node.tout);
      }
    });
  }

  RED.nodes.registerType('blynk-api-client', BlynkClientNode);

  BlynkClientNode.prototype.sendMessage = function (msg) {
    // Wait until the state of the socket is not ready and send the message when it is...
    var that = this;
    this.waitForSocketConnection(this.server, function () {
      debug("message sent!!!");
      that.server.send(msg);
    });
  }

  // Make the function wait until the connection is made...
  BlynkClientNode.prototype.waitForSocketConnection = function (socket, callback) {
    var that = this;
    setTimeout(
      function () {
        if (socket.readyState === 1) {
          debug("Connection is made")
          if (callback != null) {
            callback();
          }
        } else {
          debug("wait for connection...")
          that.waitForSocketConnection(socket, callback);
        }

      }, 5); // wait 5 milisecond for the connection...
  };

  BlynkClientNode.prototype.registerInputNode = function(/*Node*/ handler) {
    this._inputNodes.push(handler);
  };

  BlynkClientNode.prototype.removeInputNode = function(/*Node*/ handler) {
    this._inputNodes.forEach(function(node, i, inputNodes) {
      if (node === handler) {
        inputNodes.splice(i, 1);
      }
    });
  };

  BlynkClientNode.prototype.login = function(token) {
    this.sendMessage(encodeCommand(MsgType.LOGIN, 1, token))
  };

  BlynkClientNode.prototype.ping = function() {
    this.sendMessage(encodeCommand(MsgType.PING, 1, ''));
  };

  BlynkClientNode.prototype.virtualWrite = function(node, val) {
    var that = this;
    var pinType = node.pin_type;
    var pin = node.pin;
    var typeConnect = node.type_connect;
    var values;
    switch (pinType) {
      case 'D': // Digital Pin
        values = ['dw', pin, val];
        break;
      case 'A': // Analog Pin
        values = ['aw', pin, val];
        break;
      default:
        // Virtual Pin
        values = ['vw', pin, val];
        break;
    }

    var data = values.join('\0');
    if (typeConnect == 'api') {
      var uri = this.api;
      uri = uri + this.key + '/update/' + pinType + pin;
      request(
        {
          method: 'PUT',
          uri: uri,
          headers: {
            'Content-Type': 'application/json'
          },
          body: '["' + val + '"]'
        },
        function(error, response, body) {
          if (error) {
            that.sendMessage(encodeCommand(MsgType.HARDWARE, 1, data));
            return;
          }
        }
      );
    } else {
      that.sendMessage(encodeCommand(MsgType.HARDWARE, 1, data));
    }
  };

  BlynkClientNode.prototype.pinRead = function(node, val) {
    var server = this.server;
    var pinType = node.pin_type;
    var pin = node.pin;
    var typeConnect = node.type_connect;
    var values;
    var msg = {pin: pinType + pin};

    switch (pinType) {
      case 'D':
        values = ['dr', pin];
        break;
      case 'A':
        values = ['ar', pin];
        break;
      default:
        // Virtual Pin
        values = ['vr', pin];
        break;
    }
    var data = values.join('\0');

    if (typeConnect == 'api') {
      var uri = this.api;
      uri = uri + this.key + '/get/' + pinType + pin;

      request(uri, function(error, response, body) {
          if (error) {
            // switch to socket
            return;
          }
          var data = JSON.parse(body);
          if(data && data.length) {
            msg.payload = data[0];
            msg.timestamp = +new Date;
            node.send(msg);
          } else {
            node.error(body);
          }
      });
    } else {
      // TODO: read pin value via socket
      // this.sendMessage(encodeCommand(MsgType.HARDWARE, 1, data));
      node.error("TODO: read pin value via socket");
    }
  };

  BlynkClientNode.prototype.sendEmail = function(to, subject, message) {
    var values = [to, subject, message];
    var data = values.join('\0');
    this.sendMessage(encodeCommand(MsgType.EMAIL, null, data));
  };

  BlynkClientNode.prototype.handleWriteEvent = function(command) {
    for (var i = 0; i < this._inputNodes.length; i++) {
      if (
        this._inputNodes[i].nodeType == 'write' &&
        (this._inputNodes[i].pin_all || this._inputNodes[i].pin == command.pin)
      ) {
        var msg;

        msg = {
          payload: command.value,
          pin: command.pin
        };

        switch (command.operation) {
          case 'dw':
            msg.pin_type = 'D';
            break;
          case 'vw':
            msg.pin_type = 'V';
            break;
          case 'aw':
            msg.pin_type = 'A';
            break;

          default:
            console.error(
              'handleWriteEvent command.operation not handle:',
              command.operation
            );
            break;
        }
        if (command.array) {
          msg.arrayOfValues = command.array;
        }
        this._inputNodes[i].send(msg);
      }
    }
  };

  BlynkClientNode.prototype.handleReadEvent = function(command) {
    //msg._session = {type:"websocket", id:id};

    for (var i = 0; i < this._inputNodes.length; i++) {
      if (
        this._inputNodes[i].nodeType == 'read' &&
        (this._inputNodes[i].pin_all || this._inputNodes[i].pin == command.pin)
      ) {
        var msg;

        msg = {
          payload:
            /* this._inputNodes[i].pin ? this._inputNodes[i].pin : */ command.pin
        };

        switch (command.operation) {
          case 'dr':
            msg.pin_type = 'D';
            break;
          case 'vr':
            msg.pin_type = 'V';
            break;
          case 'ar':
            msg.pin_type = 'A';
            break;

          default:
            console.error(
              'handleReadEvent command.operation not handle:',
              command.operation
            );
            break;
        }

        this._inputNodes[i].send(msg);
      }
    }
  };

  BlynkClientNode.prototype.handleEvent = function(command) {
    var msg;

    msg = {
      payload: 0
    };

    //msg._session = {type:"websocket", id:id};

    for (var i = 0; i < this._inputNodes.length; i++) {
      if (this._inputNodes[i].nodeType == cmd.action) {
        this._inputNodes[i].send(msg);
      }
    }

    /*if (data instanceof Buffer) {
            console.log(">>>", data);
            console.log("Receive : " +  messageToDebugString(data) + "\r\n");
        } else {
            console.log("unexpected type : " + data + "\r\n");
        }

        var msg;
        if (this.wholemsg) {
            try {
                msg = JSON.parse(data);
            }
            catch(err) {
                msg = { payload:data };
            }
        } else {
            msg = {
                payload:data
            };
        }
        msg._session = {type:"websocket",id:id};
        for (var i = 0; i < this._inputNodes.length; i++) {
            this._inputNodes[i].send(msg);
        }*/
  };
  /*
    WebSocketListenerNode.prototype.broadcast = function(data) {
        try {
            this.sendMessage(data);
        }
        catch(e) { // swallow any errors
            this.warn("ws:"+i+" : "+e);
        }
    }
*/
  /*
    WebSocketListenerNode.prototype.reply = function(id,data) {
        var session = this._clients[id];
        if (session) {
            try {
                session.send(data);
            }
            catch(e) { // swallow any errors
            }
        }
    }
*/
  function BlynkInReadNode(n) {
    RED.nodes.createNode(this, n);
    this.server = n.client ? n.client : n.server;
    var node = this;
    this.serverConfig = RED.nodes.getNode(this.server);

    this.nodeType = 'read';
    this.pin = n.pin;
    this.pin_type = n.pin_type;
    this.pin_all = n.pin_all;

    if (this.serverConfig) {
      this.serverConfig.registerInputNode(this);
      // TODO: nls
      this.serverConfig.on('opened', function(n) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'connecting ' + n });
      });
      this.serverConfig.on('connected', function(n) {
        node.status({ fill: 'green', shape: 'dot', text: 'connected ' + n });
      });
      this.serverConfig.on('erro', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      });
      this.serverConfig.on('closed', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      });
    } else {
      this.error(RED._('websocket.errors.missing-conf'));
    }

    this.on('close', function() {
      node.serverConfig.removeInputNode(node);
    });
  }
  RED.nodes.registerType('blynk-api-in-read', BlynkInReadNode);

  function BlynkInWriteNode(n) {
    RED.nodes.createNode(this, n);
    this.server = n.client ? n.client : n.server;
    var node = this;
    this.serverConfig = RED.nodes.getNode(this.server);

    this.nodeType = 'write';
    this.pin = n.pin;
    this.pin_type = n.pin_type;
    this.pin_all = n.pin_all;

    if (this.serverConfig) {
      this.serverConfig.registerInputNode(this);
      // TODO: nls
      this.serverConfig.on('opened', function(n) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'connecting ' + n });
      });
      this.serverConfig.on('connected', function(n) {
        node.status({ fill: 'green', shape: 'dot', text: 'connected ' + n });
      });
      this.serverConfig.on('erro', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      });
      this.serverConfig.on('closed', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      });
    } else {
      this.error(RED._('websocket.errors.missing-conf'));
    }

    this.on('close', function() {
      node.serverConfig.removeInputNode(node);
    });
  }
  RED.nodes.registerType('blynk-api-in-write', BlynkInWriteNode);

  function BlynkOutWriteNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    this.server = n.client;
    this.pin = n.pin;
    this.pin_type = n.pin_type;
    this.type_connect = n.type_connect;

    this.serverConfig = RED.nodes.getNode(this.server);
    if (!this.serverConfig) {
      this.error(RED._('websocket.errors.missing-conf'));
    } else {
      // TODO: nls
      this.serverConfig.on('opened', function(n) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'connecting ' + n });
      });
      this.serverConfig.on('connected', function(n) {
        node.status({ fill: 'green', shape: 'dot', text: 'connected ' + n });
      });
      this.serverConfig.on('erro', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      });
      this.serverConfig.on('closed', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      });
    }
    this.on('input', function(msg) {
      var payload;
      // debug('writing');
      /*if (this.serverConfig.wholemsg) {
                delete msg._session;
                payload = JSON.stringify(msg);
            } else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id, payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error){
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }*/

      if (msg.hasOwnProperty('payload')) {
        if (!Buffer.isBuffer(msg.payload)) {
          // if it's not a buffer make sure it's a string.
          payload = RED.util.ensureString(msg.payload);
        } else {
          payload = msg.payload;
        }
      }
      if (payload) {
        // todo: check payload and validate
        // debug('write');
        node.serverConfig.virtualWrite(node, payload);
      }
    });
  }
  RED.nodes.registerType('blynk-api-out-write', BlynkOutWriteNode);
  RED.nodes.registerType('blynk-api-out-read', function(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    this.server = n.client;
    this.pin_type = n.pin_type;
    this.pin = n.pin;
    this.type_connect = n.type_connect;

    this.serverConfig = RED.nodes.getNode(this.server);
    if (!this.serverConfig) {
      this.error(RED._('websocket.errors.missing-conf'));
    } else {
      // TODO: nls
      this.serverConfig.on('opened', function(n) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'connecting ' + n });
      });
      this.serverConfig.on('connected', function(n) {
        node.status({ fill: 'green', shape: 'dot', text: 'connected ' + n });
      });
      this.serverConfig.on('erro', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      });
      this.serverConfig.on('closed', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      });
    }
    this.on('input', function(msg) {
      var payload;

      if (msg.hasOwnProperty('payload')) {
        if (!Buffer.isBuffer(msg.payload)) {
          // if it's not a buffer make sure it's a string.
          payload = RED.util.ensureString(msg.payload);
        } else {
          payload = msg.payload;
        }
      }
      node.serverConfig.pinRead(node, payload);
    });
  });

  function BlynkOutEmailNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    this.server = n.client;
    this.email = n.email;

    this.serverConfig = RED.nodes.getNode(this.server);
    if (!this.serverConfig) {
      this.error(RED._('websocket.errors.missing-conf'));
    } else {
      // TODO: nls
      this.serverConfig.on('opened', function(n) {
        node.status({ fill: 'yellow', shape: 'dot', text: 'connecting ' + n });
      });
      this.serverConfig.on('connected', function(n) {
        node.status({ fill: 'green', shape: 'dot', text: 'connected ' + n });
      });
      this.serverConfig.on('erro', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'error' });
      });
      this.serverConfig.on('closed', function() {
        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
      });
    }
    this.on('input', function(msg) {
      var payload;
      /*if (this.serverConfig.wholemsg) {
                delete msg._session;
                payload = JSON.stringify(msg);
            } else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id, payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error){
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }*/

      if (msg.hasOwnProperty('payload')) {
        if (!Buffer.isBuffer(msg.payload)) {
          // if it's not a buffer make sure it's a string.
          payload = RED.util.ensureString(msg.payload);
        } else {
          payload = msg.payload;
        }
      }
      if (payload) {
        // todo: check payload and validate
        // debug('write');
        var subject = payload;
        if (msg.topic) {
          subject = msg.topic;
        }
        node.serverConfig.sendEmail(node.email, subject, payload);
      }
    });
  }
  RED.nodes.registerType('blynk-api-out-email', BlynkOutEmailNode);
};
