'use strict';

var Lab = require('lab');
var Path = require('path');
var Request = require('request');
var Sinon = require('sinon');
var TrackerPopulator = require('../lib/index');
var TypeCache = require('../lib/typeCache');
var URL = require('url');

var lab = exports.lab = Lab.script();

var after = lab.after;
var afterEach = lab.afterEach;
var beforeEach = lab.beforeEach;
var describe = lab.describe;
var it = lab.it;

var fixturesPath = Path.join(__dirname, 'fixtures');
var options = {
  url: 'http://localhost/',
  csvPath: fixturesPath,
  donePath: fixturesPath,
  failPath: fixturesPath
};

describe('Tracker populator', function() {
  var sandbox = Sinon.sandbox.create();
  var get;
  var post;

  beforeEach(function(next) {
    get = sandbox.stub(Request, 'get');
    post = sandbox.stub(Request, 'post');
    next();
  });

  afterEach(function(next) {
    sandbox.restore();
    next();
  });

  after(function(next) {
    TypeCache.trackedEntityAttributeTypes = {};
    TypeCache.dataElementTypes = {};
    next();
  });

  describe('with a valid csv', function() {
    var trackedEntityInstanceID = 'some tracked entity instance id';

    it('should make the expected requests', function(next) {
      // Get attributes
      var getAttributeRequest = Sinon.match({
        url: URL.resolve(options.url, 'api/trackedEntityAttributes/attributeID'),
        json: true
      });
      get.withArgs(getAttributeRequest, Sinon.match.func).yields(
        null,
        {statusCode: 200},
        {valueType: 'string'}
      );

      // Get data elements
      var getDataElementRequest = Sinon.match({
        url: URL.resolve(options.url, 'api/dataElements/dataElementID'),
        json: true
      });
      get.withArgs(getDataElementRequest, Sinon.match.func).yields(
        null,
        {statusCode: 200},
        {valueType: 'string'}
      );
 
      // Add tracked entity
      var addTrackedEntityRequest = Sinon.match({
        url: URL.resolve(options.url, 'api/trackedEntityInstances'),
        json: Sinon.match({
          trackedEntity: 'trackedEntityID',
          orgUnit: 'expectedOrgUnit',
          attributes: Sinon.match([
            Sinon.match({attribute: 'attributeID', value: 'expectedAttribute'})
          ])
        })
      });
      post.withArgs(addTrackedEntityRequest, Sinon.match.func).yields(
        null,
        {statusCode: 201},
        {
          status: 'SUCCESS',
          reference: trackedEntityInstanceID
        }
      );
 
      // Enroll in program
      var enrollInProgramRequest = Sinon.match({
        url: URL.resolve(options.url, 'api/enrollments'),
        json: Sinon.match({
          program: 'programID',
          trackedEntityInstance: trackedEntityInstanceID,
          dateOfEnrollment: '1970-01-01',
          dateOfIncident: '1970-01-01'
        })
      });
      post.withArgs(enrollInProgramRequest, Sinon.match.func).yields(
        null,
        {statusCode: 201},
        {status: 'SUCCESS'}
      );
 
      // Add event
      var addEventRequest = Sinon.match({
        url: URL.resolve(options.url, 'api/events'),
        json: Sinon.match({
          program: 'programID',
          programStage: 'stageID',
          trackedEntityInstance: trackedEntityInstanceID,
          orgUnit: 'expectedOrgUnit',
          storedBy: 'admin',
          eventDate: '1970-01-02',
          dataValues: Sinon.match([
            Sinon.match({dataElement: 'dataElementID', value: 'expectedDataElement'})
          ])
        })
      });
      post.withArgs(addEventRequest, Sinon.match.func).yields(
        null,
        {statusCode: 201},
        {
          importSummaries: [
            {status: 'SUCCESS'}
          ]
        }
      );
 
      TrackerPopulator(options, next);
    });
  });
});