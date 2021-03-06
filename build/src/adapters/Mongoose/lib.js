

/**
 * Takes any error that resulted from the above operations throws an array of
 * errors that can be sent back to the caller as the Promise's rejection value.
 */
"use strict";

var _core = require("babel-runtime/core-js")["default"];

var _interopRequire = require("babel-runtime/helpers/interop-require")["default"];

exports.errorHandler = errorHandler;
exports.getReferencePaths = getReferencePaths;
exports.isReferencePath = isReferencePath;
exports.getReferencedModelName = getReferencedModelName;

/**
 * Takes a Resource object and returns JSON that could be passed to Mongoose
 * to create a document for that resource. The returned JSON doesn't include
 * the id (as the input resources are coming from a client, and we're
 * ignoring client-provided ids) or the type (as that is set by mongoose
 * outside of the document) or the meta (as storing that like a field may not
 * be what we want to do).
 */
exports.resourceToDocObject = resourceToDocObject;
Object.defineProperty(exports, "__esModule", {
  value: true
});
// This file contains utility functions used by the Mongoose adapter that
// aren't part of the class's public interface. Don't use them in your own
// code, as their APIs are subject to change.

var APIError = _interopRequire(require("../../types/APIError"));

function errorHandler(err) {
  var errors = [];
  //Convert validation errors collection to something reasonable
  if (err.errors) {
    for (var errKey in err.errors) {
      var thisError = err.errors[errKey];
      errors.push(new APIError(err.name === "ValidationError" ? 400 : thisError.status || 500, undefined, thisError.message, undefined, undefined, thisError.path ? [thisError.path] : undefined));
    }
  }

  // Send the raw error.
  // Don't worry about revealing internal concerns, as the pipeline maps
  // all unhandled errors to generic json-api APIError objects pre responding.
  else {
    errors.push(err);
  }

  throw errors;
}

function getReferencePaths(model) {
  var paths = [];
  model.schema.eachPath(function (name, type) {
    if (isReferencePath(type)) paths.push(name);
  });
  return paths;
}

function isReferencePath(schemaType) {
  var options = (schemaType.caster || schemaType).options;
  return options && options.ref !== undefined;
}

function getReferencedModelName(model, path) {
  var schemaType = model.schema.path(path);
  var schemaOptions = (schemaType.caster || schemaType).options;
  return schemaOptions && schemaOptions.ref;
}

function resourceToDocObject(resource) {
  var res = _core.Object.assign({}, resource.attrs);
  var getId = function (it) {
    return it.id;
  };
  for (var key in resource.links) {
    var linkage = resource.links[key].linkage.value;

    // handle linkage when set explicitly for empty relationships
    if (linkage === null || Array.isArray(linkage) && linkage.length === 0) {
      res[key] = linkage;
    } else {
      res[key] = Array.isArray(linkage) ? linkage.map(getId) : linkage.id;
    }
  }
  return res;
}