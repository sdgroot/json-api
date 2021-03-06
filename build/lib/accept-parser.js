"use strict";

var _core = require("babel-runtime/core-js")["default"];

exports["default"] = parseAccept;
exports.parseMediaType = parseMediaType;
Object.defineProperty(exports, "__esModule", {
  value: true
});

function parseAccept(accept) {
  var accepts = accept.split(",");

  for (var i = 0, j = 0; i < accepts.length; i++) {
    var mediaType = parseMediaType(accepts[i].trim(), i);

    if (mediaType) {
      accepts[j++] = mediaType;
    }
  }

  // trim accepts
  accepts.length = j;

  return accepts;
}

function parseMediaType(s, i) {
  var match = s.match(/\s*(\S+?)\/([^;\s]+)\s*(?:;(.*))?/);
  if (!match) {
    return null;
  }var type = match[1],
      subtype = match[2],
      full = "" + type + "/" + subtype,
      params = {},
      q = 1;

  if (match[3]) {
    params = match[3].split(";").map(function (s) {
      return s.trim().split("=");
    }).reduce(function (set, p) {
      set[p[0]] = p[1];
      return set;
    }, params);

    if (params.q != null) {
      q = parseFloat(params.q);
      delete params.q;
    }
  }

  return {
    type: type,
    subtype: subtype,
    params: params,
    q: q,
    i: i,
    full: full
  };
}

function getMediaTypePriority(type, accepted, index) {
  var priority = { o: -1, q: 0, s: 0 };

  for (var i = 0; i < accepted.length; i++) {
    var spec = specify(type, accepted[i], index);

    if (spec && (priority.s - spec.s || priority.q - spec.q || priority.o - spec.o) < 0) {
      priority = spec;
    }
  }

  return priority;
}

function specify(type, spec, index) {
  var p = parseMediaType(type);
  var s = 0;

  if (!p) {
    return null;
  }

  if (spec.type.toLowerCase() == p.type.toLowerCase()) {
    s |= 4;
  } else if (spec.type != "*") {
    return null;
  }

  if (spec.subtype.toLowerCase() == p.subtype.toLowerCase()) {
    s |= 2;
  } else if (spec.subtype != "*") {
    return null;
  }

  var keys = _core.Object.keys(spec.params);
  if (keys.length > 0) {
    if (keys.every(function (k) {
      return spec.params[k] == "*" || (spec.params[k] || "").toLowerCase() == (p.params[k] || "").toLowerCase();
    })) {
      s |= 1;
    } else {
      return null;
    }
  }

  return {
    i: index,
    o: spec.i,
    q: spec.q,
    s: s };
}

function preferredMediaTypes(accept, provided) {
  // RFC 2616 sec 14.2: no header = */*
  var accepts = parseAccept(accept === undefined ? "*/*" : accept || "");

  if (!provided) {
    // sorted list of all types
    return accepts.filter(isQuality).sort(compareSpecs).map(function getType(spec) {
      return spec.full;
    });
  }

  var priorities = provided.map(function getPriority(type, index) {
    return getMediaTypePriority(type, accepts, index);
  });

  // sorted list of accepted types
  return priorities.filter(isQuality).sort(compareSpecs).map(function getType(priority) {
    return provided[priorities.indexOf(priority)];
  });
}

function compareSpecs(a, b) {
  return b.q - a.q || b.s - a.s || a.o - b.o || a.i - b.i || 0;
}

function isQuality(spec) {
  return spec.q > 0;
}