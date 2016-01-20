"use strict";
/*global Buffer,process*/

var fs = require('fs');
var path = require('path');
var stream = require('stream');

var es = require('event-stream');
var extfs = require('fs-extra');
var semver = require('semver');
var vfs = require('vinyl-fs');
var yauzl = require('yauzl');
var yazl = require('yazl');

var util = module.exports = {};

function promiseCallback(resolve, reject, err, result) {
  if (err) { reject(err); } else { resolve(result); }
}

function denodeify(f) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    return new Promise(function (resolve, reject) {
      args.push(promiseCallback.bind(null, resolve, reject));
      f.apply(null, args);
    });
  };
}

util.bestVersion = semver.maxSatisfying;

util.compareVersions = function (v1, v2) {
  return semver.gt(v1, v2) ? 1 : semver.lt(v1, v2) ? -1 : 0;
}

util.copy = function (promisedInput, promisedOutput) {
  return Promise.all([promisedInput, promisedOutput])
    .then(function (io) {
      var input = io[0], output = io[1];
      return new Promise(function (resolve, reject) {
        output.once('error', reject);
        input.once('error', reject).once('end', resolve).pipe(output);
      });
    })
    ;
};

util.doNothing = function () { };

util.endsWith = function (s, postfix) {
  return postfix.length <= s.length && s.lastIndexOf(postfix) === (s.length - postfix.length);
};

util.fileExtensions = function (categories, selection) {
  var names = selection ? selection.split(',') : Object.getOwnPropertyNames(categories);
  var extensions = [];
  names.forEach(function (name) {
    Array.prototype.push.apply(extensions, (categories[name] || name).split(','));
  });
  return extensions;
};

util.filesPattern = function (categories, files) {
  if (typeof files === 'string') {
    return files;
  }
  var home = files.home || '.';
  var base = files.base || '*';
  var extensions = files.category ? util.fileExtensions(categories, files.category) : null;
  var extension;
  if (!extensions) {
    extension = '*'
  } else if (extensions.length === 1) {
    extension = extensions[0];
  } else {
    extension = '@(' + extensions.join('|') + ')';
  }
  return home + '/' + base + '.' + extension;
};

util.hasEnumerables = function (o) {
  for (var _ in o) { return true; }
  return false;
};

util.mapFiles = function (files, fn) {
  return new Promise(function (resolve, reject) {
    vfs.src(files).pipe(es.map(fn)).once('error', reject).once('end', resolve);
  });
};

util.mkdir = denodeify(extfs.mkdirs);

util.openReadStream = function (filePath, fileOpts) {
  return new Promise(function (resolve, reject) {
    if (!filePath) {
      resolve(process.stdin);
    } else {
      fs.createReadStream(filePath, fileOpts).once('error', reject)
        .once('open', function () { resolve(this); });
    }
  });
};

util.openWriteStream = function (filePath, fileOpts) {
  return new Promise(function (resolve, reject) {
    if (!filePath) {
      resolve(process.stdout);
    } else {
      util.mkdir(path.dirname(filePath))
        .then(function () {
          fs.createWriteStream(filePath, fileOpts).once('error', reject)
            .once('open', function () { resolve(this); });
        })
      ;
    }
  });
};

util.readFileText = function (vfile, withCrs) {
  var contents = vfile.contents;
  if (vfile.isStream()) {
    return util.readStreamText(contents, withCrs);
  } else {
    var result = vfile.isBuffer() ? contents.toString() : contents;
    return Promise.resolve(result);
  }
};

util.readStreamBuffer = function (input) {
  return util.readStreamChunks(input)
    .then(function (chunks) { return Buffer.concat(chunks); })
    ;
};

util.readStreamChunks = function (input) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    input
      .on('data', function (chunk) { chunks.push(chunk); })
      .on('error', reject)
      .on('end', function () { resolve(chunks); });
  });
};

util.readStreamText = function (input, withCrs) {
  input.setEncoding('utf8');
  return util.readStreamChunks(input)
    .then(function (chunks) {
      var text = chunks.join('');
      return withCrs ? text : text.replace(/\r/g, '');
    })
    ;
};

util.rmdir = denodeify(extfs.remove);

util.selectEntries = function (entries, prefix, postfix) {
  var selected = {};
  postfix = postfix || '';
  for (var key in entries) {
    if (util.startsWith(key, prefix) && util.endsWith(key, postfix)) {
      selected[key.substring(prefix.length, key.length - postfix.length)] = entries[key];
    }
  }
  return selected;
};

util.seps = new RegExp('\\' + path.sep, 'g');

util.startsWith = function (s, prefix) {
  return s.indexOf(prefix) === 0;
};

util.stat = denodeify(fs.stat);

util.streamInput = function () {
  var chunks = Array.prototype.slice.call(arguments);
  var input = new stream.Readable();
  input._read = function () {
    chunks.forEach(function (chunk) { input.push(chunk); });
    input.push(null);
  };
  return input;
};

var openZip = denodeify(yauzl.open);
util.unzip = function (filePath) {
  var zip = { entries: {} };
  return openZip(filePath, { autoClose: false })
    .then(function (yauzFile) {
      zip.file = yauzFile;
      return new Promise(function (resolve, reject) {
        yauzFile.once('error', reject).once('end', function () { resolve(zip); })
          .on('entry', function (entry) {
            var fileName = entry.fileName;
            if (zip.entries[fileName]) {
              throw new Error('Duplicate ' + fileName + ' in ' + filePath);
            }
            zip.entries[fileName] = entry;
          });
      });
    })
    ;
};

util.unzipDirectory = function (yauzFile, entries, targetDir) {
  var completions = [];
  for (var entryPath in entries) {
    var filePath = path.resolve(targetDir, entryPath);
    completions.push(util.unzipFile(yauzFile, entries[entryPath], filePath));
  }
  return Promise.all(completions).then(util.doNothing);
};

util.unzipFile = function (yauzFile, entry, filePath) {
  return util.copy(util.unzipStream(yauzFile, entry), util.openWriteStream(filePath));
};

util.unzipBuffer = function (yauzFile, entry) {
  return util.unzipStream(yauzFile, entry)
    .then(function (input) { return util.readStreamBuffer(input); })
    ;
};

util.unzipStream = function (yauzFile, entry) {
  return new Promise(function (resolve, reject) {
    yauzFile.openReadStream(entry, promiseCallback.bind(null, resolve, reject));
  });
};

util.unzipText = function (yauzFile, entry, withCrs) {
  return util.unzipStream(yauzFile, entry)
    .then(function (input) { return util.readStreamText(input, withCrs); })
    ;
};

util.vseps = /\//g;

util.zip = function (output) {
  var yazFile = new yazl.ZipFile();
  yazFile.outputStream.pipe(output);
  return yazFile;
};

util.zipBuffer = function (yazFile, relative, buffer, mtime, plain) {
  yazFile.addBuffer(buffer, relative, { mtime: mtime, compress: !plain });
};

util.zipFile = function (yazFile, relative, vfile, plain) {
  var options = { mtime: vfile.stat.mtime, mode: vfile.stat.mode, compress: !plain };
  if (vfile.isBuffer()) {
    yazFile.addBuffer(vfile.contents, relative, options);
  } else if (vfile.isStream()) {
    yazFile.addReadStream(vfile.contents, relative, options);
  }
};

util.zipStream = function (yazFile, relative, input, mtime, plain) {
  yazFile.addReadStream(input, relative, { mtime: mtime, compress: !plain });
};