'use strict';

var Async = require('async');
var Moment = require('moment');
var Request = require('request');
var TypeCache = require('./typeCache');
var URL = require('url');
var Util = require('util');
var Writable = require('stream').Writable;

function Populator(options) {
  if (typeof options.duplicateThreshold !== 'number') {
    options.duplicateThreshold = -1;
  }
  this._options = options;
  this._cache = new TypeCache();

  // Set up the queue
  this._queue = Async.queue(this._processRow.bind(this), 1);
  this._queue.drain = this.emit.bind(this, 'drain');

  Writable.call(this, {objectMode: true});
}

Util.inherits(Populator, Writable);

Populator.prototype._write = function(chunk, encoding, callback) {
  this._queue.push(chunk, callback);
  return false;
};

Populator.prototype._processRow = function(row, next) {
  this.emit('processRow');
  var tasks = [
    // Populate the map of tracked entity attributes to type
    Async.each.bind(null, Object.keys(row.attributes), this._getTrackedEntityAttributeType.bind(this)),
    // Populate the map of data elements to type
    Async.each.bind(null, Object.keys(row.dataElements), this._getDataElementType.bind(this)),
    // Track the entity
    this._addTrackedEntity.bind(this, row.parameters, row.attributes),
    // Enroll in the program
    this._enrollInProgram.bind(this, row.parameters),
    // Add the event
    this._addEvent.bind(this, row.parameters, row.dataElements)
  ];

  if (this._options.duplicateThreshold >= 0) {
    // Check for duplicate events
    tasks.splice(4, 0, this._checkForDuplicateEvent.bind(this, row.parameters));
  }

  Async.waterfall(tasks, next);
};

Populator.prototype._getTrackedEntityAttributeType = function(trackedEntityAttributeID, next) {
  if (!!this._cache.trackedEntityAttributeTypes[trackedEntityAttributeID]) {
    return next();
  }
  this.emit('getTrackedEntityAttributeType', trackedEntityAttributeID);
  Request.get({
    url: URL.resolve(this._options.url, 'api/trackedEntityAttributes/' + trackedEntityAttributeID),
    json: true
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }
    if (res.statusCode !== 200) {
      return next(new Error('Unexpected status code ' + res.statusCode));
    }
    this._cache.trackedEntityAttributeTypes[trackedEntityAttributeID] = body.valueType;
    if (!this._cache.firstUniqueTrackedEntityAttributeID && body.unique === true) {
      this._cache.firstUniqueTrackedEntityAttributeID = trackedEntityAttributeID;
    }
    next();
  }.bind(this));
};

Populator.prototype._getDataElementType = function(dataElementID, next) {
  if (!!this._cache.dataElementTypes[dataElementID]) {
    return next();
  }
  this.emit('getDataElementType', dataElementID);
  Request.get({
    url: URL.resolve(this._options.url, 'api/dataElements/' + dataElementID),
    json: true
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }
    if (!~[200, 404].indexOf(res.statusCode)) {
      return next(new Error('Unexpected status code ' + res.statusCode));
    }
    this._cache.dataElementTypes[dataElementID] = body.type;
    next();
  }.bind(this));
};

Populator.prototype._addTrackedEntity = function(knownKeys, trackedEntityAttributes, next) {
  this.emit('addTrackedEntity');
  var payload = {
    trackedEntity: this._options.trackedEntityID,
    orgUnit: knownKeys.orgUnit,
    attributes: []
  };
  for (var key in trackedEntityAttributes) {
    payload.attributes.push(this._cache.createTrackedEntityAttribute(key, trackedEntityAttributes[key]));
  }

  var requestTime = Date.now();
  var request = Request.post({
    url: URL.resolve(this._options.url, 'api/trackedEntityInstances'),
    json: payload
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }
    this.emit('addTrackedEntityResponse', res, {
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: JSON.parse(request.body.toString()),
      timestamp: requestTime
    });
    if (res.statusCode !== 201) {
      return next(new Error('Unexpected status code ' + res.statusCode));
    }
    if (typeof body === 'string') {
      return next(new Error('Could not parse response body'));
    }
    if (body.status !== 'SUCCESS') {
      if (body.conflicts.length === 1 && /non-unique/i.test(body.conflicts[0].value)) {
        return this._getTrackedEntityInstanceID(knownKeys, trackedEntityAttributes, function(err, trackedEntityInstanceID) {
          if (err) {
            return next(err);
          }
          this._updateTrackedEntityInstance(knownKeys, trackedEntityAttributes, trackedEntityInstanceID, next);
        }.bind(this));
      }
      return next(new Error('Adding tracked entity failed'));
    }
    next(null, body.reference);
  }.bind(this));
};

Populator.prototype._getTrackedEntityInstanceID = function(knownKeys, trackedEntityAttributes, next) {
  this.emit('getTrackedEntityInstanceID');
  var value = trackedEntityAttributes[this._cache.firstUniqueTrackedEntityAttributeID];
  if (!value) {
    return next(new Error('No unique attributes found'));
  }
  if (this._cache.trackedEntityAttributeTypes[this._cache.firstUniqueTrackedEntityAttributeID] === 'number') {
    value = parseInt(value);
  }
  Request.get({
    url: URL.resolve(this._options.url, 'api/trackedEntityInstances'),
    qs: {
      ou: knownKeys.orgUnit,
      attribute: this._cache.firstUniqueTrackedEntityAttributeID + ':EQ:' + value
    },
    json: true
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }
    if (!body.rows[0]) {
      return next(new Error('Failed to look up existing tracked entity instance'));
    }
    return next(null, body.rows[0][0]);
  });
};

Populator.prototype._updateTrackedEntityInstance = function(knownKeys, trackedEntityAttributes, trackedEntityInstanceID, next) {
  this.emit('updateTrackedEntityInstance');
  var payload = {
    trackedEntity: this._options.trackedEntityID,
    orgUnit: knownKeys.orgUnit,
    attributes: []
  };
  for (var key in trackedEntityAttributes) {
    payload.attributes.push(this._cache.createTrackedEntityAttribute(key, trackedEntityAttributes[key]));
  }

  var requestTime = Date.now();
  var request = Request.put({
    url: URL.resolve(this._options.url, 'api/trackedEntityInstances/' + trackedEntityInstanceID),
    json: payload
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }
    this.emit('updateTrackedEntityInstanceResponse', res, {
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: JSON.parse(request.body.toString()),
      timestamp: requestTime
    });
    if (res.statusCode !== 200) {
      return next(new Error('Unexpected status code ' + res.statusCode));
    }
    if (body.status !== 'SUCCESS') {
      return next(new Error('Updating tracked entity failed'));
    }
    next(null, trackedEntityInstanceID);
  }.bind(this));
};

Populator.prototype._enrollInProgram = function(knownKeys, trackedEntityInstanceID, next) {
  this.emit('enrollInProgram');
  var payload = {
    program: this._options.programID,
    trackedEntityInstance: trackedEntityInstanceID,
    dateOfEnrollment: knownKeys.programDate,
    dateOfIncident: knownKeys.programDate
  };

  var requestTime = Date.now();
  var request = Request.post({
    url: URL.resolve(this._options.url, 'api/enrollments'),
    json: payload
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }
    this.emit('enrollInProgramResponse', res, {
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: JSON.parse(request.body.toString()),
      timestamp: requestTime
    });
    if (res.statusCode === 409) {
      return next(null, trackedEntityInstanceID);
    }
    if (!body) {
      return next(new Error('Invalid response body'));
    }
    if (body.status !== 'SUCCESS') {
      return next(null, trackedEntityInstanceID);
    }
    next(null, trackedEntityInstanceID);
  }.bind(this));
};

Populator.prototype._checkForDuplicateEvent = function(knownKeys, trackedEntityInstanceID, next) {
  this.emit('checkForDuplicateEvent');

  var eventDate = Moment(knownKeys.eventDate, ['YYYY-MM-DD']);
  if (!eventDate.isValid() || eventDate.parsingFlags().overflow !== -1 || eventDate.parsingFlags().charsLeftOver !== 0) {
    return next(new Error('Invalid date ' + knownKeys.eventDate));
  }

  Request.get({
    url: URL.resolve(this._options.url, 'api/events'),
    qs: {
      program: this._options.programID,
      programStage: this._options.stageID,
      trackedEntityInstance: trackedEntityInstanceID,
      orgUnit: knownKeys.orgUnit,
      startDate: eventDate.subtract(this._options.duplicateThreshold, 'days').format('YYYY-MM-DD')
    },
    json: true
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }

    if (res.statusCode !== 200) {
      return next(new Error('Unexpected status code ' + res.statusCode));
    }

    if (!body.events || body.events.length === 0) {
      return next(null, trackedEntityInstanceID);
    }

    next(new Error('Duplicate event'));
  });
};

Populator.prototype._addEvent = function(knownKeys, dataElements, trackedEntityInstanceID, next) {
  this.emit('addEvent');
  var payload = {
    program: this._options.programID,
    programStage: this._options.stageID,
    trackedEntityInstance: trackedEntityInstanceID,
    orgUnit: knownKeys.orgUnit,
    storedBy: 'admin',
    eventDate: knownKeys.eventDate,
    dataValues: []
  };
  for (var key in dataElements) {
    payload.dataValues.push(this._cache.createDataElement(key, dataElements[key]));
  }

  var requestTime = Date.now();
  var request = Request.post({
    url: URL.resolve(this._options.url, 'api/events'),
    json: payload
  }, function(err, res, body) {
    if (err) {
      return next(err);
    }
    this.emit('addEventResponse', res, {
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: JSON.parse(request.body.toString()),
      timestamp: requestTime
    });
    if (res.statusCode > 203 || !body || body.importSummaries[0].status !== 'SUCCESS') {
      return next(new Error('Adding event failed'));
    }
    next();
  }.bind(this));
};

module.exports = Populator;
