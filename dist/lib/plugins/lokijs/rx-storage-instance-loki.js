"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createLokiStorageInstance = exports.createLokiLocalState = exports.RxStorageInstanceLoki = void 0;

var _rxjs = require("rxjs");

var _util = require("../../util");

var _rxError = require("../../rx-error");

var _lokijsHelper = require("./lokijs-helper");

var _rxSchemaHelper = require("../../rx-schema-helper");

var _rxStorageHelper = require("../../rx-storage-helper");

var createLokiStorageInstance = function createLokiStorageInstance(storage, params, databaseSettings) {
  try {
    var _temp7 = function _temp7() {
      var instance = new RxStorageInstanceLoki(storage, params.databaseName, params.collectionName, params.schema, _internals, params.options, databaseSettings);
      /**
       * Directly create the localState if the db becomes leader.
       */

      if (params.multiInstance) {
        (0, _util.ensureNotFalsy)(_internals.leaderElector).awaitLeadership().then(function () {
          if (!instance.closed) {
            (0, _lokijsHelper.mustUseLocalState)(instance);
          }
        });
      }

      return instance;
    };

    var _internals = {};

    var _temp8 = function () {
      if (params.multiInstance) {
        var leaderElector = (0, _lokijsHelper.getLokiLeaderElector)(storage, params.databaseName);
        _internals.leaderElector = leaderElector;
      } else {
        // optimisation shortcut, directly create db is non multi instance.
        _internals.localState = createLokiLocalState(params, databaseSettings);
        return Promise.resolve(_internals.localState).then(function () {});
      }
    }();

    return Promise.resolve(_temp8 && _temp8.then ? _temp8.then(_temp7) : _temp7(_temp8));
  } catch (e) {
    return Promise.reject(e);
  }
};

exports.createLokiStorageInstance = createLokiStorageInstance;

var createLokiLocalState = function createLokiLocalState(params, databaseSettings) {
  try {
    if (!params.options) {
      params.options = {};
    }

    return Promise.resolve((0, _lokijsHelper.getLokiDatabase)(params.databaseName, databaseSettings)).then(function (databaseState) {
      /**
       * Construct loki indexes from RxJsonSchema indexes.
       * TODO what about compound indexes? Are they possible in lokijs?
       */
      var indices = [];

      if (params.schema.indexes) {
        params.schema.indexes.forEach(function (idx) {
          if (!(0, _util.isMaybeReadonlyArray)(idx)) {
            indices.push(idx);
          }
        });
      }
      /**
       * LokiJS has no concept of custom primary key, they use a number-id that is generated.
       * To be able to query fast by primary key, we always add an index to the primary.
       */


      var primaryKey = (0, _rxSchemaHelper.getPrimaryFieldOfPrimaryKey)(params.schema.primaryKey);
      indices.push(primaryKey);
      var lokiCollectionName = params.collectionName + '-' + params.schema.version;
      var collectionOptions = Object.assign({}, lokiCollectionName, {
        indices: indices,
        unique: [primaryKey]
      }, _lokijsHelper.LOKIJS_COLLECTION_DEFAULT_OPTIONS);
      var collection = databaseState.database.addCollection(lokiCollectionName, collectionOptions);
      databaseState.collections[params.collectionName] = collection;
      var ret = {
        databaseState: databaseState,
        collection: collection
      };
      return ret;
    });
  } catch (e) {
    return Promise.reject(e);
  }
};

exports.createLokiLocalState = createLokiLocalState;
var instanceId = (0, _util.now)();

var RxStorageInstanceLoki = /*#__PURE__*/function () {
  function RxStorageInstanceLoki(storage, databaseName, collectionName, schema, internals, options, databaseSettings) {
    var _this = this;

    this.changes$ = new _rxjs.Subject();
    this.lastChangefeedSequence = 0;
    this.instanceId = instanceId++;
    this.closed = false;
    this.storage = storage;
    this.databaseName = databaseName;
    this.collectionName = collectionName;
    this.schema = schema;
    this.internals = internals;
    this.options = options;
    this.databaseSettings = databaseSettings;
    this.primaryPath = (0, _rxSchemaHelper.getPrimaryFieldOfPrimaryKey)(this.schema.primaryKey);

    _lokijsHelper.OPEN_LOKIJS_STORAGE_INSTANCES.add(this);

    if (this.internals.leaderElector) {
      this.internals.leaderElector.awaitLeadership().then(function () {
        // this instance is leader now, so it has to reply to queries from other instances
        (0, _util.ensureNotFalsy)(_this.internals.leaderElector).broadcastChannel.addEventListener('message', function (msg) {
          try {
            return Promise.resolve((0, _lokijsHelper.handleRemoteRequest)(_this, msg));
          } catch (e) {
            return Promise.reject(e);
          }
        });
      });
    }
  }

  var _proto = RxStorageInstanceLoki.prototype;

  _proto.bulkWrite = function bulkWrite(documentWrites) {
    try {
      var _this3 = this;

      if (documentWrites.length === 0) {
        throw (0, _rxError.newRxError)('P2', {
          args: {
            documentWrites: documentWrites
          }
        });
      }

      return Promise.resolve((0, _lokijsHelper.mustUseLocalState)(_this3)).then(function (localState) {
        if (!localState) {
          return (0, _lokijsHelper.requestRemoteInstance)(_this3, 'bulkWrite', [documentWrites]);
        }

        var ret = {
          success: {},
          error: {}
        };
        var docsInDb = new Map();
        var docsInDbWithLokiKey = new Map();
        documentWrites.forEach(function (writeRow) {
          var id = writeRow.document[_this3.primaryPath];
          var documentInDb = localState.collection.by(_this3.primaryPath, id);

          if (documentInDb) {
            docsInDbWithLokiKey.set(id, documentInDb);
            docsInDb.set(id, (0, _lokijsHelper.stripLokiKey)(documentInDb));
          }
        });
        var categorized = (0, _rxStorageHelper.categorizeBulkWriteRows)(_this3, _this3.primaryPath, docsInDb, documentWrites);
        categorized.bulkInsertDocs.forEach(function (writeRow) {
          var docId = writeRow.document[_this3.primaryPath];
          localState.collection.insert((0, _util.flatClone)(writeRow.document));
          ret.success[docId] = writeRow.document;
        });
        categorized.bulkUpdateDocs.forEach(function (writeRow) {
          var docId = writeRow.document[_this3.primaryPath];
          var documentInDbWithLokiKey = (0, _util.getFromMapOrThrow)(docsInDbWithLokiKey, docId);
          var writeDoc = Object.assign({}, writeRow.document, {
            $loki: documentInDbWithLokiKey.$loki
          });
          localState.collection.update(writeDoc);
          ret.success[docId] = writeRow.document;
        });
        categorized.errors.forEach(function (err) {
          ret.error[err.documentId] = err;
        });
        localState.databaseState.saveQueue.addWrite();

        if (categorized.eventBulk.events.length > 0) {
          _this3.changes$.next(categorized.eventBulk);
        }

        return ret;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.findDocumentsById = function findDocumentsById(ids, deleted) {
    try {
      var _this5 = this;

      return Promise.resolve((0, _lokijsHelper.mustUseLocalState)(_this5)).then(function (localState) {
        if (!localState) {
          return (0, _lokijsHelper.requestRemoteInstance)(_this5, 'findDocumentsById', [ids, deleted]);
        }

        var ret = {};
        ids.forEach(function (id) {
          var documentInDb = localState.collection.by(_this5.primaryPath, id);

          if (documentInDb && (!documentInDb._deleted || deleted)) {
            ret[id] = (0, _lokijsHelper.stripLokiKey)(documentInDb);
          }
        });
        return ret;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.query = function query(preparedQuery) {
    try {
      var _this7 = this;

      return Promise.resolve((0, _lokijsHelper.mustUseLocalState)(_this7)).then(function (localState) {
        if (!localState) {
          return (0, _lokijsHelper.requestRemoteInstance)(_this7, 'query', [preparedQuery]);
        }

        var query = localState.collection.chain().find(preparedQuery.selector);

        if (preparedQuery.sort) {
          query = query.sort((0, _lokijsHelper.getLokiSortComparator)(_this7.schema, preparedQuery));
        }
        /**
         * Offset must be used before limit in LokiJS
         * @link https://github.com/techfort/LokiJS/issues/570
         */


        if (preparedQuery.skip) {
          query = query.offset(preparedQuery.skip);
        }

        if (preparedQuery.limit) {
          query = query.limit(preparedQuery.limit);
        }

        var foundDocuments = query.data().map(function (lokiDoc) {
          return (0, _lokijsHelper.stripLokiKey)(lokiDoc);
        });
        return {
          documents: foundDocuments
        };
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.getAttachmentData = function getAttachmentData(_documentId, _attachmentId) {
    throw new Error('Attachments are not implemented in the lokijs RxStorage. Make a pull request.');
  };

  _proto.getChangedDocumentsSince = function getChangedDocumentsSince(limit, checkpoint) {
    try {
      var _this9 = this;

      return Promise.resolve((0, _lokijsHelper.mustUseLocalState)(_this9)).then(function (localState) {
        if (!localState) {
          return (0, _lokijsHelper.requestRemoteInstance)(_this9, 'getChangedDocumentsSince', [limit, checkpoint]);
        }

        var sinceLwt = checkpoint ? checkpoint.lwt : _util.RX_META_LWT_MINIMUM;
        var query = localState.collection.chain().find({
          '_meta.lwt': {
            $gte: sinceLwt
          }
        }).sort((0, _util.getSortDocumentsByLastWriteTimeComparator)(_this9.primaryPath));
        var changedDocs = query.data();
        var first = changedDocs[0];

        if (checkpoint && first && first[_this9.primaryPath] === checkpoint.id && first._meta.lwt === checkpoint.lwt) {
          changedDocs.shift();
        }

        changedDocs = changedDocs.slice(0, limit);
        return changedDocs.map(function (docData) {
          return {
            document: (0, _lokijsHelper.stripLokiKey)(docData),
            checkpoint: {
              id: docData[_this9.primaryPath],
              lwt: docData._meta.lwt
            }
          };
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.changeStream = function changeStream() {
    return this.changes$.asObservable();
  };

  _proto.cleanup = function cleanup(minimumDeletedTime) {
    try {
      var _this11 = this;

      return Promise.resolve((0, _lokijsHelper.mustUseLocalState)(_this11)).then(function (localState) {
        if (!localState) {
          return (0, _lokijsHelper.requestRemoteInstance)(_this11, 'cleanup', [minimumDeletedTime]);
        }

        var deleteAmountPerRun = 10;
        var maxDeletionTime = (0, _util.now)() - minimumDeletedTime;
        var query = localState.collection.chain().find({
          _deleted: true,
          '_meta.lwt': {
            $lt: maxDeletionTime
          }
        }).limit(deleteAmountPerRun);
        var foundDocuments = query.data();

        if (foundDocuments.length > 0) {
          localState.collection.remove(foundDocuments);
          localState.databaseState.saveQueue.addWrite();
        }

        return foundDocuments.length !== deleteAmountPerRun;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.close = function close() {
    try {
      var _temp3 = function _temp3() {
        (0, _lokijsHelper.removeLokiLeaderElectorReference)(_this13.storage, _this13.databaseName);
      };

      var _this13 = this;

      _this13.closed = true;

      _this13.changes$.complete();

      _lokijsHelper.OPEN_LOKIJS_STORAGE_INSTANCES["delete"](_this13);

      var _temp4 = function () {
        if (_this13.internals.localState) {
          return Promise.resolve(_this13.internals.localState).then(function (localState) {
            return Promise.resolve((0, _lokijsHelper.getLokiDatabase)(_this13.databaseName, _this13.databaseSettings)).then(function (dbState) {
              return Promise.resolve(dbState.saveQueue.run()).then(function () {
                return Promise.resolve((0, _lokijsHelper.closeLokiCollections)(_this13.databaseName, [localState.collection])).then(function () {});
              });
            });
          });
        }
      }();

      return Promise.resolve(_temp4 && _temp4.then ? _temp4.then(_temp3) : _temp3(_temp4));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.remove = function remove() {
    try {
      var _this15 = this;

      return Promise.resolve((0, _lokijsHelper.mustUseLocalState)(_this15)).then(function (localState) {
        if (!localState) {
          return (0, _lokijsHelper.requestRemoteInstance)(_this15, 'remove', []);
        }

        localState.databaseState.database.removeCollection(localState.collection.name);
        return _this15.close();
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  return RxStorageInstanceLoki;
}();

exports.RxStorageInstanceLoki = RxStorageInstanceLoki;
//# sourceMappingURL=rx-storage-instance-loki.js.map