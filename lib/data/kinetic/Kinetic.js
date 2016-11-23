import crypto from 'crypto';
import EventEmitter from 'events';
import net from 'net';
import stream from 'stream';

import { errors } from 'arsenal';
import kineticlib from 'kinetic-js';

const HEADER_SZ = 9;

class Kinetic {

    /**
     * @constructor
     * @param {Object.<string>[]} drives - the list of drives
     * @returns {Kinetic} - to allow for a functional style.
     */
    constructor(drives) {
        this._sockets = [];
        this._drives = drives;
        this._sockets = this._drives.map(drive => ({
            drive,
            clusterVersion: 0,
            connectionID: 0,
            sock: this._newSocket(),
            _request: false,
            _requestGet: false,
            _events: new EventEmitter(),
        }));
        this._chunkTab = [];
        this._count = 0;
        this._lexiKey = '0';
        this.connect();
        return this;
    }

    /**
     * Connect the sockets to the drives
     * @return {undefined}
     */
    connect() {
        this._sockets.forEach((socket, index) => {
            socket.sock.on('connect', () => {
                this._bindReadable(socket, index);
            }).connect(socket.drive);
        });
    }

    getIt() {
        for (let i = 0; i < this._sockets.length; i++) {
            if (this._sockets[i]._request === false
                && this._sockets[i]._requestGet === false) {
                return i;
            }
        }
        this._sockets.push(
            {
                drive: { host: '127.0.0.1', port: '8123' },
                clusterVersion: 0,
                connectionID: 0,
                sequence: this._sequence,
                sock: this._newSocket(),
                _request: false,
                _requestGet: false,
                _events: new EventEmitter(),
            });
        const index = this._sockets.length - 1;
        const sock = this._sockets[index];
        return sock.sock.on('connect', () => {
            this._bindReadable(sock, index);
        }).connect(sock.drive);
    }

    _bindReadable(socket, index) {
        socket.sock.on('readable', err => {
            if (socket._requestGet === false) {
                this._parsePDU(socket, (err1, pdu) => {
                    this._parseRequest(err || err1, pdu, index);
                });
            } else {
                this._endGet(index);
            }
        });
	socket.sock.on('error', err => {
	    console.log('==========================');
	    console.log('==========================');
	    console.log('==========================');
	    console.log('==========================');
	    console.log('==========================');
	    console.log('==========================');
	    console.log('==========================');
	    console.log('==========================');
	    console.log('there is an error : ');
	    console.log(err);
	});
    }

    _parsePDU(socket, callback) {
        const header = socket.sock.read(HEADER_SZ);
        if (header !== null) {
            const protobufSize = header.readInt32BE(1);
            const rawData = socket.sock.read(protobufSize);
            if (rawData !== null) {
                const pdu = new kineticlib.PDU(
                    Buffer.concat([header, rawData]));
                const err = this._propError(pdu);
                return callback(err, pdu);
            }
        }
        return undefined;
    }

    _parseRequest(err, pdu, index) {
        const socket = this._sockets[index];
        switch (pdu.getMessageType()) {
        case null:
            socket.connectionID = pdu.getConnectionId();
            socket.clusterVersion = pdu.getClusterVersion();
            socket.index = index;
            if (!socket.sequence) {
                socket.sequence = 0;
            }
            return pdu;
        case kineticlib.ops.PUT_RESPONSE:
            this._sockets[index]._request = false;
            this._sockets[index]._events.emit('putResponse', err);
            break;
        case kineticlib.ops.DELETE_RESPONSE:
            this._sockets[index]._request = false;
            this._sockets[index]._events.emit('deleteResponse', err);
            break;
        case kineticlib.ops.GET_RESPONSE:
            this._sockets[index]._request = false;
	    console.log('------------------');
	    console.log(err);
            if (err) {
                this._sockets[index]._events.emit('getResponse', err);
            } else {
                this._startGet(index, pdu);
            }
            break;
        default:
            break;
        }
        return undefined;
    }

    _startGet(index, pdu) {
        let chunk = Buffer.allocUnsafe(0);
        this._sockets[index]._requestGet = true;
        this._sockets[index]._chunkSize = pdu.getChunkSize();
        chunk = this._sockets[index].sock.read();
        this._count += chunk.length;
        if (this._count === this._sockets[index]._chunkSize) {
            const tag = crypto.createHmac('sha1', 'asdfasdf').update(chunk)
                      .digest();
            if (!pdu.checkTagIntegrity(tag)) {
                this._sockets[index]._events.emit(
                    'getResponse', errors.InternalError);
            }
            this._sockets[index]._events.emit('getResponse', null, chunk);
        } else {
            this._chunkTab.push(chunk);
        }
    }

    _endGet(index) {
        let chunk = Buffer.allocUnsafe(0);
        if (this._count !== this._sockets[index]._chunkSize) {
            chunk = this._sockets[index].sock.read();
            this._chunkTab.push(chunk);
            this._count += chunk.length;
        }
        if (this._count === this._sockets[index]._chunkSize) {
            this._sockets[index]._events.emit(
                'getResponse', null, Buffer.concat(this._chunkTab));
        }
    }

    _newSocket() {
        const socket = new net.Socket().pause();
        socket.setNoDelay();
        socket.setKeepAlive(true);
        socket.unref();
        return socket;
    }

    _propError(pdu) {
        const statusCode = pdu.getStatusCode();
        if (statusCode === kineticlib.errors.NOT_FOUND) {
            return errors.ObjNotFound;
        }
        if (statusCode !== kineticlib.errors.SUCCESS) {
            return pdu.getErrorMessage();
        }
        return undefined;
    }

    /**
     * set the sequence of the request.
     *
     * @param {number} index - the index of the socket.
     * @param {number} sequence - the sequence to be set.
     * @returns {Kinetic} - To allow for a functional style.
     */
    setSequence(index, sequence) {
        if (sequence >= Number.MAX_VALUE) {
            const temp = this._sockets[index].sock;
            this._sockets[index].sock = this._newSocket();
            this._sockets[index].sock.on('connect', () => {
                this._bindReadable(this._sockets[index], index);
            }).connect(this._sockets[index].drive);
            temp.destroy();
            this._sockets[index].sequence = 0;
        } else {
            this._sequence = sequence;
            this._sockets[index].sequence = sequence;
        }
        return this;
    }

    /**
     * get the pool of socket.
     *
     * @returns {Kinetic._sockets} - the pool of socket.
     */
    getSockets() {
        return this._sockets;
    }

    /**
     * get the socket at the index.
     *
     * @param {number} index - the index of the socket.
     * @returns {Object} - the socket.
     */
    getSocket(index) {
        return this._sockets[index];
    }

    /**
     * get index of the socket.
     *
     * @param {string} host - the host of the socket.
     * @param {string} port - the port of the socket.
     * @returns {number|object} - the index of the socket or null if it does not
     *                            exist.
     */
    getSocketIndex(host, port) {
        this._sockets.forEach((socket, index) => {
            if (socket.host === host && socket.port === port) {
                return index;
            }
            if (index === this._sockets.length - 1) {
                return null;
            }
            return undefined;
        });
    }

    _incrString(str) {
        this._lexiKey = (parseInt(str, 36) + 1).toString(36);
        return this._lexiKey;
    }

    /**
     * send the put request to the right drive.
     *
     * @param {number} index - the index of the socket
     * @param {Buffer} value - the value to be put.
     * @param {Object} options - the options object for the put request:
     *                     kinetic-protocol
     *        {string} options.synchronization - synchronization mode
     *        {boolean} options.force - option for forcing the put
     * @param {function} callback - the callback
     * @returns {undefined}.
     */
    put(index, value, options, callback) {
	console.log("puTTTTTT");
        this._sockets[index]._request = true;
        const socket = this._sockets[index];
        const key = Buffer.concat([Buffer.from(
            `${socket.drive.host}:${socket.drive.port}:` +
            `${this._incrString(this._lexiKey)}`)]);
        // this._lexiKey = ;
        const tag = crypto.createHmac('sha1', 'asdfasdf').update(value)
                  .digest();
        const pdu = new kineticlib.PutPDU(
            socket.sequence, socket.connectionID, socket.clusterVersion,
            key, value.length, tag, options);
        this.setSequence(index, socket.sequence + 1);
        const header = pdu.read();
        const len = header.length + value.length;
        return socket.sock.write(Buffer.concat([header, value], len), err => {
            if (err) {
                return callback(err);
            }
            return this._sockets[index]._events.once(
                'putResponse', err => callback(err, key));
        });
    }

    /**
     * send the get request to the right drive.
     *
     * @param {number} index - the index of the socket
     * @param {Buffer} key - the value to be put.
     * @param {number[]} range - the range to get
     * @param {function} callback - the callback
     * @returns {undefined}.
     */
    get(index, key, range, callback) {
        let endValue = Buffer.allocUnsafe(0);
        this._sockets[index]._request = true;
        const socket = this._sockets[index];
	console.log('===============KEY')
	console.log(key.toString());
        const pdu = new kineticlib.GetPDU(
            socket.sequence, socket.connectionID,
            socket.clusterVersion, key);
        this.setSequence(index, socket.sequence + 1);
        const header = pdu.read();
        socket.sock.write(header, err => {
            if (err) {
                return callback(err);
            }
            return socket._events.once('getResponse', (err, chunk) => {
                if (err) {
                    return callback(err);
                }

                this._sockets[index]._requestGet = false;
                this._chunkTab = [];
                this._count = 0;
                if (range) {
                    endValue = chunk.slice(range[0], range[1] + 1);
                } else {
                    endValue = chunk;
                }
                return callback(err, new stream.Readable({
                    read() {
                        this.push(endValue);
                        this.push(null);
                    },
                }));
            });
        });
    }

    /**
     * send the delete request to the right drive.
     *
     * @param {number} index - the index of the socket
     * @param {Buffer} key - the value to be put.
     * @param {object} options - the options for the delete request
     *                 options.force - to force the delete
     *                 options.synchronization - the type of the delete
     * @param {function} callback - the callback
     * @returns {undefined}.
     */
    delete(index, key, options, callback) {
        this._sockets[index]._request = true;
        const socket = this._sockets[index];
        const pdu = new kineticlib.DeletePDU(
            socket.sequence, socket.connectionID,
            socket.clusterVersion, key, options);
        this.setSequence(index, socket.sequence + 1);
        socket.sock.write(pdu.read(), err => {
            if (err) {
                return callback(err);
            }
            return this._sockets[index]._events.once(
                'deleteResponse', err => callback(err));
        });
    }
}

export default Kinetic;
