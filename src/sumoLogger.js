const superagent = require('superagent');
const formatDate = require('./formatDate');

const DEFAULT_INTERVAL = 0;
const DEFAULT_BATCH = 0;
const NOOP = () => {};

function getUUID() {
  // eslint gets funny about bitwise
  /* eslint-disable */
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const piece = (Math.random() * 16) | 0;
    const elem = c === 'x' ? piece : (piece & 0x3) | 0x8;
    return elem.toString(16);
  });
  /* eslint-enable */
}

/**
 * Axios has been replaced with SuperAgent (issue #28), to maintain some backwards
 * compatibility the SuperAgent response object is marshaled to conform
 * to the Axios response object
 */
function marshalHttpResponse(response) {
  const statusMessage = response.res ? response.res.statusMessage : '';
  return {
    data: response.body,
    status: response.status,
    statusText: response.statusText || statusMessage,
    headers: response.headers,
    request: response.xhr || response.req,
    config: response.req,
  };
}

class SumoLogger {
  constructor(options) {
    if (
      !options
      || !Object.prototype.hasOwnProperty.call(options, 'endpoint')
      || options.endpoint === undefined
      || options.endpoint === ''
    ) {
      console.error('An endpoint value must be provided');
      return;
    }

    this.config = {};
    this.pendingLogs = [];
    this.interval = 0;
    this.logSending = false;

    this.setConfig(options);
    this.startLogSending();
  }

  setConfig(newConfig) {
    this.config = {
      endpoint: newConfig.endpoint,
      returnPromise: Object.prototype.hasOwnProperty.call(
          newConfig,
          'returnPromise'
        )
        ? newConfig.returnPromise
        : true,
      clientUrl: newConfig.clientUrl || '',
      useIntervalOnly: newConfig.useIntervalOnly || false,
      interval: newConfig.interval || DEFAULT_INTERVAL,
      batchSize: newConfig.batchSize || DEFAULT_BATCH,
      sourceName: newConfig.sourceName || '',
      hostName: newConfig.hostName || '',
      sourceCategory: newConfig.sourceCategory || '',
      session: newConfig.sessionKey || getUUID(),
      onSuccess: newConfig.onSuccess || NOOP,
      onError: newConfig.onError || NOOP,
      graphite: newConfig.graphite || false,
      raw: newConfig.raw || false,
      carbon2: newConfig.carbon2 || false,
    };
  }

  updateConfig(newConfig = {}) {
    if (newConfig.endpoint) {
      this.config.endpoint = newConfig.endpoint;
    }
    if (newConfig.returnPromise) {
      this.config.returnPromise = newConfig.returnPromise;
    }
    if (newConfig.useIntervalOnly) {
      this.config.useIntervalOnly = newConfig.useIntervalOnly;
    }
    if (newConfig.interval) {
      this.config.interval = newConfig.interval;
      this.startLogSending();
    }
    if (newConfig.batchSize) {
      this.config.batchSize = newConfig.batchSize;
    }
    if (newConfig.sourceCategory) {
      this.config.sourceCategory = newConfig.sourceCategory;
    }
  }

  batchReadyToSend() {
    if (this.config.batchSize === 0) {
      return this.config.interval === 0;
    } else {
      const pendingMessages = this.pendingLogs.reduce((acc, curr) => {
        const log = JSON.parse(curr);
        return acc + log.msg + '\n';
      }, '');
      const pendingBatchSize = pendingMessages.length;
      const ready = pendingBatchSize >= this.config.batchSize;
      if (ready) {
        this.stopLogSending();
      }
      return ready;
    }
  }

  _postSuccess(logsSentLength) {
    this.pendingLogs = this.pendingLogs.slice(logsSentLength);
    this.logSending = false;
    // Reset interval if needed:
    this.startLogSending();
    this.config.onSuccess();
  }

  sendLogs() {
    if (this.logSending || this.pendingLogs.length === 0) {
      return false;
    }

    try {
      this.logSending = true;

      const headers = {
        'X-Sumo-Client': 'sumo-javascript-sdk',
      };
      if (this.config.graphite) {
        Object.assign(headers, {
          'Content-Type': 'application/vnd.sumologic.graphite',
        });
      } else if (this.config.carbon2) {
        Object.assign(headers, {
          'Content-Type': 'application/vnd.sumologic.carbon2',
        });
      } else {
        Object.assign(headers, { 'Content-Type': 'application/json' });
      }
      if (this.config.sourceName !== '') {
        Object.assign(headers, {
          'X-Sumo-Name': this.config.sourceName,
        });
      }
      if (this.config.sourceCategory !== '') {
        Object.assign(headers, {
          'X-Sumo-Category': this.config.sourceCategory,
        });
      }
      if (this.config.hostName !== '') {
        Object.assign(headers, { 'X-Sumo-Host': this.config.hostName });
      }

      if (this.config.returnPromise && this.pendingLogs.length === 1) {
        return superagent
          .post(this.config.endpoint)
          .set(headers)
          .send(this.pendingLogs.join('\n'))
          .then(marshalHttpResponse)
          .then((res) => {
            this._postSuccess(1);
            return res;
          })
          .catch((error) => {
            this.config.onError(error);
            this.logSending = false;
            return Promise.reject(error);
          });
      }

      const logsToSend = Array.from(this.pendingLogs);
      return superagent
        .post(this.config.endpoint)
        .set(headers)
        .send(logsToSend.join('\n'))
        .then(marshalHttpResponse)
        .then(() => {
          this._postSuccess(logsToSend.length);
        })
        .catch((error) => {
          this.config.onError(error);
          this.logSending = false;
          if (this.config.returnPromise) {
            return Promise.reject(error);
          }
        });
    } catch (ex) {
      this.config.onError(ex);
      return false;
    }
  }

  startLogSending() {
    if (this.config.interval > 0) {
      if (this.interval) {
        this.stopLogSending();
      }
      this.interval = setInterval(() => {
        this.sendLogs();
      }, this.config.interval);
    }
  }

  stopLogSending() {
    clearInterval(this.interval);
  }

  emptyLogQueue() {
    this.pendingLogs = [];
  }

  flushLogs() {
    return this.sendLogs();
  }

  log(msg, optionalConfig = {}) {

    const type = typeof msg;

    if (type === 'undefined') {
      console.error('A value must be provided');
      return false;
    }

    if (type === 'object') {
      const check = msg;
      if (Object.keys(check).length === 0) {
        console.error('A non-empty JSON object must be provided');
        return false;
      }

      if (
        this.config.graphite
        && (!Object.prototype.hasOwnProperty.call(check, 'path')
          || !Object.prototype.hasOwnProperty.call(check, 'value'))
      ) {
        console.error(
          'Both "path" and "value" properties must be provided in the message object to send Graphite metrics'
        );
        return false;
      }

      if (
        this.config.carbon2
        && (!Object.prototype.hasOwnProperty.call(check, 'intrinsic_tags')
          || !Object.prototype.hasOwnProperty.call(check, 'meta_tags')
          || !Object.prototype.hasOwnProperty.call(check, 'value'))
      ) {
        console.error(
          'All "intrinsic_tags", "meta_tags" and "value" properties must be provided in the message object to send Carbon2 metrics'
        );
        return false;
      }
    }

    const {
      sessionKey,
      timestamp: date,
      url: perMessageUrl
    } = optionalConfig;

    const _date = date || new Date();
    const sessionId = sessionKey || this.config.session;
    const url = perMessageUrl && { url: perMessageUrl }
      || this.config.clientUrl && { url: this.config.clientUrl }
      || {};

    const timestamp = formatDate(_date);
    const message = [].concat(msg);
    const messages = message.map((item) => {
      if (this.config.graphite) {
        return `${item.path} ${item.value} ${Math.round(ts.getTime() / 1000)}`;
      }
      if (this.config.carbon2) {
        return `${item.intrinsic_tags}  ${item.meta_tags} ${
          item.value
        } ${Math.round(ts.getTime() / 1000)}`;
      }
      if (this.config.raw) {
        return item;
      }

      const msg = typeof item === "string" ? { msg: item } : item

      return JSON.stringify(Object.assign(msg, { sessionId, timestamp }, url));
    });

    this.pendingLogs = this.pendingLogs.concat(messages);

    if (!this.config.useIntervalOnly && this.batchReadyToSend()) {
      return this.sendLogs();
    }
  }
}

module.exports = SumoLogger;

