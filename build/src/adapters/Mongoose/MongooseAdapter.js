"use strict";

var _classCallCheck = require("babel-runtime/helpers/class-call-check")["default"];

var _createClass = require("babel-runtime/helpers/create-class")["default"];

var _defineProperty = require("babel-runtime/helpers/define-property")["default"];

var _core = require("babel-runtime/core-js")["default"];

var _interopRequire = require("babel-runtime/helpers/interop-require")["default"];

var _interopRequireWildcard = require("babel-runtime/helpers/interop-require-wildcard")["default"];

var Q = _interopRequire(require("q"));

var mongoose = _interopRequire(require("mongoose"));

var _utilArrays = require("../../util/arrays");

var arrayContains = _utilArrays.arrayContains;
var arrayValuesMatch = _utilArrays.arrayValuesMatch;

var deleteNested = require("../../util/misc").deleteNested;

var _utilTypeHandling = require("../../util/type-handling");

var forEachArrayOrVal = _utilTypeHandling.forEachArrayOrVal;
var mapResources = _utilTypeHandling.mapResources;
var groupResourcesByType = _utilTypeHandling.groupResourcesByType;

var util = _interopRequireWildcard(require("./lib"));

var pluralize = _interopRequire(require("pluralize"));

var Resource = _interopRequire(require("../../types/Resource"));

var Collection = _interopRequire(require("../../types/Collection"));

var Linkage = _interopRequire(require("../../types/Linkage"));

var LinkObject = _interopRequire(require("../../types/LinkObject"));

var APIError = _interopRequire(require("../../types/APIError"));

var MongooseAdapter = (function () {
  function MongooseAdapter(models, inflector, idGenerator) {
    _classCallCheck(this, MongooseAdapter);

    this.models = models || mongoose.models;
    this.inflector = inflector || pluralize;
    this.idGenerator = idGenerator;
  }

  _createClass(MongooseAdapter, {
    find: {

      /**
       * Returns a Promise for an array of two items: the primary resources (either
       * a single Resource or a Collection) and the included resources, as an array.
       *
       * Note: The correct behavior if idOrIds is an empty array is to return no
       * documents, as happens below. If it's undefined, though, we're not filtering
       * by id and should return all documents.
       */

      value: function find(type, idOrIds, fields, sorts, filters, includePaths) {
        var _this = this;

        var model = this.getModel(this.constructor.getModelName(type));
        var queryBuilder = new mongoose.Query(null, null, model, model.collection);
        var pluralizer = this.inflector.plural;
        var mode = "find",
            idQuery = undefined;
        var primaryDocumentsPromise = undefined,
            includedResourcesPromise = Q(null);

        if (idOrIds) {
          if (typeof idOrIds === "string") {
            mode = "findOne";
            idQuery = idOrIds;
          } else {
            idQuery = { $in: idOrIds };
          }

          queryBuilder[mode]({ _id: idQuery });
        } else {
          queryBuilder.find();
        }

        // do sorting
        if (Array.isArray(sorts)) {
          sorts = sorts.map(function (it) {
            return it.startsWith("+") ? it.substr(1) : it;
          });
          queryBuilder.sort(sorts.join(" "));
        }

        // filter out invalid records with simple fields equality.
        // note that there's a non-trivial risk of sql-like injection here.
        // we're mostly protected by the fact that we're treating the filter's
        // value as a single string, though, and not parsing as JSON.
        if (typeof filters === "object" && !Array.isArray(filters)) {
          queryBuilder.where(filters);
        }

        // in an ideal world, we'd use mongoose here to filter the fields before
        // querying. But, because the fields to filter can be scoped by type and
        // we don't always know about a document's type until after query (becuase
        // of discriminator keys), and because filtering out fields can really
        // complicate population for includes, we don't yet filter at query time but
        // instead just hide filtered fields in @docToResource. There is a more-
        // efficient way to do this down the road, though--something like taking the
        // provided fields and expanding them just enough (by looking at the type
        // heirarachy and the relationship paths) to make sure that we're not going
        // to run into any of the problems outlined above, while still querying for
        // less data than we would without any fields restriction. For reference, the
        // code for safely using the user's `fields` input, by putting them into a
        // mongoose `.select()` object so that the user can't prefix a field with a
        // minus on input to affect the query, is below.
        // Reference: http://mongoosejs.com/docs/api.html#query_Query-select.
        // let arrToSelectObject = (prev, curr) => { prev[curr] = 1; return prev; };
        // for(let type in fields) {
        //   fields[type] = fields[type].reduce(arrToSelectObject, {});
        // }

        // support includes, but only a level deep for now (recursive includes,
        // especially if done in an efficient way query wise, are a pain in the ass).
        if (includePaths) {
          (function () {
            var populatedPaths = [];
            var refPaths = util.getReferencePaths(model);

            includePaths = includePaths.map(function (it) {
              return it.split(".");
            });
            includePaths.forEach(function (pathParts) {
              // first, check that the include path is valid.
              if (!arrayContains(refPaths, pathParts[0])) {
                var title = "Invalid include path.";
                var detail = "Resources of type \"" + type + "\" don't have a(n) \"" + pathParts[0] + "\" relationship.";
                throw new APIError(400, undefined, title, detail);
              }

              if (pathParts.length > 1) {
                throw new APIError(501, undefined, "Multi-level include paths aren't yet supported.");
              }

              // Finally, do the population
              populatedPaths.push(pathParts[0]);
              queryBuilder.populate(pathParts[0]);
            });

            var includedResources = [];
            primaryDocumentsPromise = Q(queryBuilder.exec()).then(function (docs) {
              forEachArrayOrVal(docs, function (doc) {
                populatedPaths.forEach(function (path) {
                  // if it's a toOne relationship, doc[path] will be a doc or undefined;
                  // if it's a toMany relationship, we have an array (or undefined).
                  var refDocs = Array.isArray(doc[path]) ? doc[path] : [doc[path]];
                  refDocs.forEach(function (it) {
                    // only include if it's not undefined.
                    if (it) {
                      includedResources.push(_this.constructor.docToResource(it, pluralizer, fields));
                    }
                  });
                });
              });

              return docs;
            });

            includedResourcesPromise = primaryDocumentsPromise.then(function () {
              return new Collection(includedResources);
            });
          })();
        } else {
          primaryDocumentsPromise = Q(queryBuilder.exec());
        }

        return Q.all([primaryDocumentsPromise.then(function (it) {
          var makeCollection = !idOrIds || Array.isArray(idOrIds) ? true : false;
          return _this.constructor.docsToResourceOrCollection(it, makeCollection, pluralizer, fields);
        }), includedResourcesPromise])["catch"](util.errorHandler);
      }
    },
    create: {

      /**
       * Returns a Promise that fulfills with the created Resource. The Promise
       * may also reject with an error if creation failed or was unsupported.
       *
       * @param {string} parentType - All the resources to be created must be this
       *   type or be sub-types of it.
       * @param {(Resource|Collection)} resourceOrCollection - The resource or
       *   collection of resources to create.
       */

      value: function create(parentType, resourceOrCollection) {
        var _this = this;

        var resourcesByType = groupResourcesByType(resourceOrCollection);

        // Note: creating the resources as we do below means that we do one
        // query for each type, as opposed to only one query for all of the
        // documents. That's unfortunately much slower, but it ensures that
        // mongoose runs all the user's hooks.
        var creationPromises = [];
        var setIdWithGenerator = function (doc) {
          doc._id = _this.idGenerator(doc);
        };
        for (var type in resourcesByType) {
          var model = this.getModel(this.constructor.getModelName(type));
          var resources = resourcesByType[type];
          var docObjects = resources.map(util.resourceToDocObject);

          if (typeof this.idGenerator === "function") {
            forEachArrayOrVal(docObjects, setIdWithGenerator);
          }

          creationPromises.push(Q.ninvoke(model, "create", docObjects));
        }

        return Q.all(creationPromises).then(function (docArrays) {
          var makeCollection = resourceOrCollection instanceof Collection;
          var finalDocs = docArrays.reduce(function (a, b) {
            return a.concat(b);
          }, []);
          return _this.constructor.docsToResourceOrCollection(finalDocs, makeCollection, _this.inflector.plural);
        })["catch"](util.errorHandler);
      }
    },
    update: {

      /**
       * @param {string} parentType - All the resources to be created must be this
       *   type or be sub-types of it.
       * @param {Object} resourceOrCollection - The changed Resource or Collection
       *   of resources. Should only have the fields that are changed.
       */

      value: function update(parentType, resourceOrCollection) {
        var _this = this;

        // It'd be faster to bypass Mongoose Document creation & just have mongoose
        // send a findAndUpdate command directly to mongo, but we want Mongoose's
        // standard validation and lifecycle hooks, and so we have to find first.
        // Note that, starting in Mongoose 4, we'll be able to run the validations
        // on update, which should be enough, so we won't need to find first.
        // https://github.com/Automattic/mongoose/issues/860
        var model = this.getModel(this.constructor.getModelName(parentType));
        var singular = this.inflector.singular;
        var plural = this.inflector.plural;

        // Set up some data structures based on resourcesOrCollection
        var resourceTypes = [];
        var changeSets = {};
        var idOrIds = mapResources(resourceOrCollection, function (it) {
          changeSets[it.id] = it;
          resourceTypes.push(it.type);
          return it.id;
        });

        var mode = typeof idOrIds === "string" ? "findOne" : "find";
        var idQuery = typeof idOrIds === "string" ? idOrIds : { $in: idOrIds };

        return Q(model[mode]({ _id: idQuery }).exec()).then(function (docs) {
          var successfulSavesPromises = [];

          // if some ids were invalid/deleted/not found, we can't let *any* update
          // succeed. this is the beginning of our simulation of transactions.
          // There are two types of invalid cases here: we looked up one or more
          // docs and got none back (i.e. docs === null) or we looked up an array of
          // docs and got back docs that were missing some requested ids.
          if (docs === null) {
            throw new APIError(404, undefined, "No matching resource found.");
          } else {
            var idOrIdsAsArray = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
            var docIdOrIdsAsArray = Array.isArray(docs) ? docs.map(function (it) {
              return it.id;
            }) : [docs.id];

            if (!arrayValuesMatch(idOrIdsAsArray, docIdOrIdsAsArray)) {
              var title = "Some of the resources you're trying to update could not be found.";
              throw new APIError(404, undefined, title);
            }
          }

          forEachArrayOrVal(docs, function (currDoc) {
            var newResource = changeSets[currDoc.id];

            // Allowing the type to change is a bit of a pain. If the type's
            // changed, it means the mongoose Model representing the doc must be
            // different too. So we have to get the data from the old doc with
            // .toObject(), change its discriminator, and then create an instance
            // of the new model with that data. We also have to mark that new
            // instance as not representing a new document, so that mongoose will
            // do an update query rather than a save. Finally, we have to do all
            // this before updating other attributes, so that they're correctly
            // marked as modified when changed.
            var currentModelName = currDoc.constructor.modelName;
            var newModelName = _this.constructor.getModelName(newResource.type, singular);
            if (currentModelName !== newModelName) {
              var newDoc = currDoc.toObject();
              var newModel = _this.getModel(newModelName);
              newDoc[currDoc.constructor.schema.options.discriminatorKey] = newModelName;

              // replace the currDoc with our new creation.
              currDoc = new newModel(newDoc);
              currDoc.isNew = false;
            }

            // update all attributes and links provided, ignoring type/meta/id.
            currDoc.set(util.resourceToDocObject(newResource));

            successfulSavesPromises.push(Q.Promise(function (resolve, reject) {
              currDoc.save(function (err, doc) {
                if (err) reject(err);
                resolve(doc);
              });
            }));
          });

          return Q.all(successfulSavesPromises);
        }).then(function (docs) {
          var makeCollection = resourceOrCollection instanceof Collection;
          return _this.constructor.docsToResourceOrCollection(docs, makeCollection, plural);
        })["catch"](util.errorHandler);
      }
    },
    "delete": {
      value: function _delete(parentType, idOrIds) {
        var model = this.getModel(this.constructor.getModelName(parentType));
        var mode = "find",
            idQuery = undefined;

        if (!idOrIds) {
          return Q.Promise(function (resolve, reject) {
            reject(new APIError(400, undefined, "You must specify some resources to delete"));
          });
        } else if (typeof idOrIds === "string") {
          mode = "findOne";
          idQuery = idOrIds;
        } else {
          idQuery = { $in: idOrIds };
        }

        return Q(model[mode]({ _id: idQuery }).exec()).then(function (docs) {
          forEachArrayOrVal(docs, function (it) {
            it.remove();
          });
          return docs;
        })["catch"](util.errorHandler);
      }
    },
    addToRelationship: {

      /**
       * Unlike update(), which would do full replacement of a to-many relationship
       * if new linkage was provided, this method adds the new linkage to the existing
       * relationship. It doesn't do a find-then-save, so some mongoose hooks may not
       * run. But validation and the update query hooks will work if you're using
       * Mongoose 4.0.
       */

      value: function addToRelationship(type, id, relationshipPath, newLinkage) {
        var model = this.getModel(this.constructor.getModelName(type));
        var update = {
          $addToSet: _defineProperty({}, relationshipPath, { $each: newLinkage.value.map(function (it) {
              return it.id;
            }) })
        };
        var options = { runValidators: true };

        return Q.ninvoke(model, "findOneAndUpdate", { _id: id }, update, options)["catch"](util.errorHandler);
      }
    },
    removeFromRelationship: {
      value: function removeFromRelationship(type, id, relationshipPath, linkageToRemove) {
        var model = this.getModel(this.constructor.getModelName(type));
        var update = {
          $pullAll: _defineProperty({}, relationshipPath, linkageToRemove.value.map(function (it) {
            return it.id;
          }))
        };
        var options = { runValidators: true };

        return Q.ninvoke(model, "findOneAndUpdate", { _id: id }, update, options)["catch"](util.errorHandler);
      }
    },
    getModel: {
      value: function getModel(modelName) {
        return this.models[modelName];
      }
    },
    getTypesAllowedInCollection: {
      value: function getTypesAllowedInCollection(parentType) {
        var parentModel = this.getModel(this.constructor.getModelName(parentType, this.inflector.singular));
        return [parentType].concat(this.constructor.getChildTypes(parentModel, this.inflector.plural));
      }
    },
    getRelationshipNames: {

      /**
       * Return the paths that, for the provided type, must always must be filled
       * with relationship info, if they're present. Occassionally, a path might be
       * optionally fillable w/ relationship info; this shouldn't return those paths.
       */

      value: function getRelationshipNames(type) {
        var model = this.getModel(this.constructor.getModelName(type, this.inflector.singular));
        return util.getReferencePaths(model);
      }
    }
  }, {
    docsToResourceOrCollection: {

      /**
       * We want to always return a collection when the user is asking for something
       * that's logically a Collection (even if it only has 1 item), and a Resource
       * otherwise. But, because mongoose returns a single doc if you query for a
       * one-item array of ids, and because we sometimes generate arrays (e.g. of
       * promises for documents' successful creation) even when only creating/updating
       * one document, just looking at whether docs is an array isn't enough to tell
       * us whether to return a collection or not. And, in all these cases, we want
       * to handle the possibility that the query returned no documents when we needed
       * one, such that we must 404. This function centralizes all that logic.
       *
       * @param docs The docs to turn into a resource or collection
       * @param makeCollection Whether we're making a collection.
       * @param pluralizer An inflector function for setting the Resource's type
       */

      value: function docsToResourceOrCollection(docs, makeCollection, pluralizer, fields) {
        var _this = this;

        // if docs is an empty array and we're making a collection, that's ok.
        // but, if we're looking for a single doc, we must 404 if we didn't find any.
        if (!docs || !makeCollection && Array.isArray(docs) && docs.length === 0) {
          throw new APIError(404, undefined, "No matching resource found.");
        }

        docs = !Array.isArray(docs) ? [docs] : docs;
        docs = docs.map(function (it) {
          return _this.docToResource(it, pluralizer, fields);
        });
        return makeCollection ? new Collection(docs) : docs[0];
      }
    },
    docToResource: {

      // Useful to have this as static for calling as a utility outside this class.

      value: function docToResource(doc, _x, fields) {
        var _this = this;

        var pluralizer = arguments[1] === undefined ? pluralize.plural : arguments[1];

        var type = this.getType(doc.constructor.modelName, pluralizer);
        var refPaths = util.getReferencePaths(doc.constructor);
        var schemaOptions = doc.constructor.schema.options;

        // Get and clean up attributes
        // Note: we can't use the depopulate attribute because it doesn't just
        // depopulate fields _inside_ the passed in doc, but can actually turn the
        // doc itself into a string if the doc was originally gotten by population.
        // That's stupid, and it breaks our include handling.
        // Also, starting in 4.0, we won't need the delete versionKey line:
        // https://github.com/Automattic/mongoose/issues/2675
        var attrs = doc.toJSON({ virtuals: true });
        delete attrs.id; // from the id virtual.
        delete attrs._id;
        delete attrs[schemaOptions.versionKey];
        delete attrs[schemaOptions.discriminatorKey];

        // Delete attributes that aren't in the included fields.
        // TODO: Some virtuals could be expensive to compute, so, if field
        // restrictions are in use, we shouldn't set {virtuals: true} above and,
        // instead, we should read only the virtuals that are needed (by searching
        // the schema to identify the virtual paths and then checking those against
        // fields) and add them to newAttrs.
        if (fields && fields[type]) {
          (function () {
            var newAttrs = {};
            fields[type].forEach(function (field) {
              if (attrs[field]) {
                newAttrs[field] = attrs[field];
              }
            });
            attrs = newAttrs;
          })();
        }

        // Build Links
        var links = {};
        var getProp = function (obj, part) {
          return obj[part];
        };

        refPaths.forEach(function (path) {
          // skip if applicable
          if (fields && fields[type] && !arrayContains(fields[type], path)) {
            return;
          }

          // get value at the path w/ the reference, in both the json'd + full docs.
          var pathParts = path.split(".");
          var jsonValAtPath = pathParts.reduce(getProp, attrs);
          var referencedType = _this.getReferencedType(doc.constructor, path);

          // delete the attribute, since we're moving it to links
          deleteNested(path, attrs);

          // Now, since the value wasn't excluded, we need to build its LinkObject.
          // Note: the value could still be null or an empty array. And, because of
          // of population, it could be a single document or array of documents,
          // in addition to a single/array of ids. So, as is customary, we'll start
          // by coercing it to an array no matter what, tracking whether to make it
          // a non-array at the end, to simplify our code.
          var isToOneRelationship = false;

          if (!Array.isArray(jsonValAtPath)) {
            jsonValAtPath = [jsonValAtPath];
            isToOneRelationship = true;
          }

          var linkage = [];
          jsonValAtPath.forEach(function (docOrIdOrNull) {
            var idOrNull = undefined;

            // if it has an ._id key, it's a document.
            if (docOrIdOrNull && docOrIdOrNull._id) {
              idOrNull = String(docOrIdOrNull._id);
            } else {
              // Even though we did toJSON(), id may be an ObjectId. (lame.)
              idOrNull = docOrIdOrNull ? String(docOrIdOrNull) : null;
            }

            linkage.push(idOrNull ? { type: referencedType, id: idOrNull } : null);
          });

          // go back from an array if neccessary and save.
          linkage = new Linkage(isToOneRelationship ? linkage[0] : linkage);
          links[path] = new LinkObject(linkage);
        });

        // finally, create the resource.
        return new Resource(type, doc.id, attrs, links);
      }
    },
    getModelName: {
      value: function getModelName(type) {
        var singularizer = arguments[1] === undefined ? pluralize.singular : arguments[1];

        var words = type.split("-");
        words[words.length - 1] = singularizer(words[words.length - 1]);
        return words.map(function (it) {
          return it.charAt(0).toUpperCase() + it.slice(1);
        }).join("");
      }
    },
    getType: {

      // Get the json api type name for a model.

      value: function getType(modelName) {
        var pluralizer = arguments[1] === undefined ? pluralize.plural : arguments[1];

        return pluralizer(modelName.replace(/([A-Z])/g, "-$1").slice(1).toLowerCase());
      }
    },
    getReferencedType: {
      value: function getReferencedType(model, path) {
        var pluralizer = arguments[2] === undefined ? pluralize.plural : arguments[2];

        return this.getType(util.getReferencedModelName(model, path), pluralizer);
      }
    },
    getChildTypes: {
      value: function getChildTypes(model) {
        var _this = this;

        var pluralizer = arguments[1] === undefined ? pluralize.plural : arguments[1];

        if (!model.discriminators) {
          return [];
        }return _core.Object.keys(model.discriminators).map(function (it) {
          return _this.getType(it, pluralizer);
        });
      }
    },
    getStandardizedSchema: {
      value: function getStandardizedSchema(model) {
        var _this = this;

        var schemaOptions = model.schema.options;
        var versionKey = schemaOptions.versionKey;
        var discriminatorKey = schemaOptions.discriminatorKey;
        var virtuals = model.schema.virtuals;
        var standardSchema = {};

        // valid types are String, Array[String], Number, Array[Number], Boolean,
        // Array[Boolean], Date, Array[Date], Id (for a local id), ModelNameId and
        // Array[ModelNameId].
        var getStandardType = function (path, schemaType) {
          if (path === "_id") {
            return { name: "Id", isArray: false, targetModel: undefined };
          }

          var typeOptions = schemaType.options.type;
          var holdsArray = Array.isArray(typeOptions);
          var baseType = holdsArray ? typeOptions[0].type.name : typeOptions.name;
          var refModelName = util.getReferencedModelName(model, path);

          return {
            name: refModelName ? "Link" : baseType,
            isArray: holdsArray,
            targetModel: refModelName
          };
        };

        model.schema.eachPath(function (name, type) {
          if (arrayContains([versionKey, discriminatorKey], name)) {
            return;
          }

          var standardType = getStandardType(name, type);
          name = name === "_id" ? "id" : name;
          var likelyAutoGenerated = name === "id" || standardType.name === "Date" && /created|updated|modified/.test(name) && typeof type.options["default"] === "function";

          var defaultVal = undefined;
          if (likelyAutoGenerated) {
            defaultVal = "(auto generated)";
          } else if (type.options["default"] && typeof type.options["default"] !== "function") {
            defaultVal = type.options["default"];
          }

          // Add validation info
          var validationRules = {
            required: !!type.options.required,
            oneOf: type.options["enum"] ? type.enumValues : undefined,
            max: type.options.max ? type.options.max : undefined
          };

          type.validators.forEach(function (validator) {
            _core.Object.assign(validationRules, validator[0].JSONAPIDocumentation);
          });

          standardSchema[name] = {
            type: standardType,
            friendlyName: _this.toFriendlyName(name),
            "default": defaultVal,
            validation: validationRules
          };
        });

        for (var virtual in virtuals) {
          // skip the id virtual, since we properly handled _id above.
          if (virtual === "id") {
            continue;
          }

          // for virtual properties, we can't infer type or validation rules at all,
          // so we add them with just a friendly name and leave the rest undefined.
          // The user is expected to override/set this in a resource type description.
          standardSchema[virtual] = {
            friendlyName: this.toFriendlyName(virtual),
            type: {},
            validation: {}
          };
        }

        return standardSchema;
      }
    },
    toFriendlyName: {
      value: function toFriendlyName(pathOrModelName) {
        var ucFirst = function (v) {
          return v.charAt(0).toUpperCase() + v.slice(1);
        };

        // pascal case is "upper camel case", i.e. "MyName" as opposed to "myName".
        // this variable holds a normalized, pascal cased version of pathOrModelName,
        // such that `ModelFormat`, `pathFormat` `nested.path.format` all become
        // ModelFormat, PathFormat, and NestedPathFormat.
        var pascalCasedString = pathOrModelName.split(".").map(ucFirst).join("");

        // Now, to handle acronyms like InMLBTeam, we need to define a word as a
        // capital letter, plus (0 or more capital letters where the capital letter
        // is not followed by a non-capital letter or 0 or more non capital letters).
        var matches = undefined;
        var words = [];
        var wordsRe = /[A-Z]([A-Z]*(?![^A-Z])|[^A-Z]*)/g;

        while ((matches = wordsRe.exec(pascalCasedString)) !== null) {
          words.push(matches[0]);
        }

        return words.join(" ");
      }
    }
  });

  return MongooseAdapter;
})();

module.exports = MongooseAdapter;