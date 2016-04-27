"use strict";
/*global Buffer,process*/

const fs = require('fs');
const path = require('path');
const stream = require('stream');

const es = require('event-stream');
const extfs = require('fs-extra');
const semver = require('semver');
const vfs = require('vinyl-fs');
const yauzl = require('yauzl');
const yazl = require('yazl');

const util = module.exports = {};

function promiseCallback(resolve, reject) {
  return (err, result) => err ? reject(err) : resolve(result)
}

function denodeify(f) {
  return function() {
    const args = [...arguments];
    return new Promise((resolve, reject) => {
      args.push(promiseCallback(resolve, reject));
      f(...args);
    });
  };
}

util.bestVersion = semver.maxSatisfying;

util.compareVersions = (v1, v2) => semver.gt(v1, v2) ? 1 : semver.lt(v1, v2) ? -1 : 0;

util.copy = (promisedInput, promisedOutput) => Promise.all([promisedInput, promisedOutput])
  .then(io => {
    const input = io[0], output = io[1];
    return new Promise((resolve, reject) => {
      output.once('error', reject);
      input.once('error', reject).once('end', resolve).pipe(output);
    });
  })
  ;

util.copyJSON = (promisedJSON, promisedOutput) => Promise.resolve(promisedJSON)
  .then(json => util.copy(util.streamInput(JSON.stringify(json, null, ' ')), promisedOutput))
  ;

util.doNothing = () => { };

util.eachFile = (files, fn) => new Promise((resolve, reject) => {
  vfs.src(files, { allowEmpty: true }).pipe(es.map((file, cb) => {
    Promise.resolve(fn(file)).then(() => cb(null));
  })).once('error', reject).once('end', resolve);
});

util.endsWith = (s, postfix) =>
  postfix.length <= s.length && s.lastIndexOf(postfix) === (s.length - postfix.length);

util.fileExtensions = (categories, selection) => {
  const extensions = [];
  for (let name of selection ? selection.split(',') : Object.keys(categories)) {
    extensions.push(...(categories[name] || name).split(','));
  }
  return extensions;
};

util.filesPattern = (categories, files) => {
  if (typeof files === 'string') {
    return files;
  }
  const home = files.home || '.', base = files.base || '*';
  const extensions = files.category ? util.fileExtensions(categories, files.category) : null;
  const extension = !extensions ? '*' : extensions.length === 1 ? extensions[0] :
    `@(${extensions.join('|')})`;
  return home + '/' + base + '.' + extension;
};

util.hasEnumerables = o => {
  for (let _ in o) { return true; }
  return false;
};

util.mkdir = denodeify(extfs.mkdirs);

util.openReadStream = (filePath, fileOpts) => new Promise((resolve, reject) => {
  if (!filePath) {
    resolve(process.stdin);
  } else {
    fs.createReadStream(filePath, fileOpts)
      .once('error', reject).once('open', function() { resolve(this); });
  }
});

util.openWriteStream = (filePath, fileOpts) => new Promise((resolve, reject) => {
  if (!filePath) {
    resolve(process.stdout);
  } else {
    util.mkdir(path.dirname(filePath))
      .then(() => {
        fs.createWriteStream(filePath, fileOpts)
          .once('error', reject).once('open', function() { resolve(this); });
      })
      ;
  }
});

util.readFileText = (vfile, withCrs) => {
  const contents = vfile.contents;
  return vfile.isStream() ? util.readStreamText(contents, withCrs) :
    Promise.resolve(vfile.isBuffer() ? contents.toString() : contents);
};

util.readStreamBuffer = input => util.readStreamChunks(input)
  .then(chunks => Buffer.concat(chunks))
  ;

util.readStreamChunks = input => new Promise((resolve, reject) => {
  const chunks = [];
  input.on('error', reject)
    .on('data', chunk => { chunks.push(chunk); })
    .on('end', () => { resolve(chunks); });
});

util.readStreamText = (input, withCrs) => {
  input.setEncoding('utf8');
  return util.readStreamChunks(input)
    .then(chunks => chunks.join(''))
    .then(text => withCrs ? text : text.replace(/\r/g, ''))
    ;
};

util.rmdir = denodeify(extfs.remove);

util.selectEntries = (entries, prefix, postfix) => {
  postfix = postfix || '';
  const selected = {};
  for (let key in entries) {
    if (util.startsWith(key, prefix) && util.endsWith(key, postfix)) {
      selected[key.substring(prefix.length, key.length - postfix.length)] = entries[key];
    }
  }
  return selected;
};

util.seps = new RegExp('\\' + path.sep, 'g');

util.startsWith = (s, prefix) => s.indexOf(prefix) === 0;

util.stat = denodeify(fs.stat);

util.streamInput = function() {
  const chunks = [...arguments];
  const input = new stream.Readable();
  input._read = () => {
    for (let chunk of chunks) {
      input.push(chunk);
    }
    input.push(null);
  };
  return input;
};

const openZip = denodeify(yauzl.open);
util.unzip = filePath => openZip(filePath, { autoClose: false })
  .then(yauzFile => new Promise((resolve, reject) => {
    const zip = { entries: {}, file: yauzFile };
    yauzFile.once('error', reject).once('end', () => resolve(zip))
      .on('entry', entry => {
        const fileName = entry.fileName;
        if (zip.entries[fileName]) {
          throw new Error(`Duplicate ${fileName} in ${filePath}`);
        }
        zip.entries[fileName] = entry;
      });
  }))
  ;

util.unzipDirectory = (yauzFile, entries, targetDir) => {
  const files = Object.keys(entries).map(entryPath => {
    const filePath = path.resolve(targetDir, entryPath);
    return util.unzipFile(yauzFile, entries[entryPath], filePath)
  });
  return Promise.all(files).then(util.doNothing);
};

util.unzipFile = (yauzFile, entry, filePath) =>
  util.copy(util.unzipStream(yauzFile, entry), util.openWriteStream(filePath));

util.unzipBuffer = (yauzFile, entry) => util.unzipStream(yauzFile, entry)
  .then(input => util.readStreamBuffer(input))
  ;

util.unzipStream = (yauzFile, entry) => new Promise((resolve, reject) => {
  yauzFile.openReadStream(entry, promiseCallback(resolve, reject));
});

util.unzipText = (yauzFile, entry, withCrs) => util.unzipStream(yauzFile, entry)
  .then(input => util.readStreamText(input, withCrs))
  ;

util.vseps = /\//g;

util.zip = output => {
  const yazFile = new yazl.ZipFile();
  yazFile.outputStream.pipe(output);
  return yazFile;
};

util.zipBuffer = (yazFile, relative, buffer, mtime, plain) => {
  yazFile.addBuffer(buffer, relative, { mtime: mtime, compress: !plain });
};

util.zipFile = (yazFile, relative, vfile, plain) => {
  const options = { mtime: vfile.stat.mtime, mode: vfile.stat.mode, compress: !plain };
  if (vfile.isBuffer()) {
    yazFile.addBuffer(vfile.contents, relative, options);
  } else if (vfile.isStream()) {
    yazFile.addReadStream(vfile.contents, relative, options);
  }
};

util.zipStream = (yazFile, relative, input, mtime, plain) => {
  yazFile.addReadStream(input, relative, { mtime: mtime, compress: !plain });
};