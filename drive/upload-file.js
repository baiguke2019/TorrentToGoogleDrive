const parseRange = require('http-range-parse');
const request = require('request');
const fs = require('fs');
const driveAuth = require('./drive-auth.js');
/**
   * Divide the file to multi path for upload
   * @returns {array} array of chunk info
   */
function getChunks (filePath, start) {
  var allsize = fs.statSync(filePath).size;
  var sep = allsize < (150 * 1024 * 1024) ? allsize : (150 * 1024 * 1024) - 1;
  var ar = [];
  for (var i = start; i < allsize; i += sep) {
    var bstart = i;
    var bend = i + sep - 1 < allsize ? i + sep - 1 : allsize - 1;
    var cr = 'bytes ' + bstart + '-' + bend + '/' + allsize;
    var clen = bend != allsize - 1 ? sep : allsize - i;
    var stime = allsize < (150 * 1024 * 1024) ? 5000 : 10000;
    ar.push({
      bstart: bstart,
      bend: bend,
      cr: cr,
      clen: clen,
      stime: stime
    });
  }
  return ar;
}

/**
   * Upload one chunk to server: this api is using for onedrive and google
   * @returns {string} file id if any
   */
function uploadChunk (filePath, chunk, mineType, uploadUrl) {
  return new Promise((resolve, reject) => {
    request.put({
      url: uploadUrl,
      headers: {
        'Content-Length': chunk.clen,
        'Content-Range': chunk.cr,
        'Content-Type': mineType
      },
      body: fs.createReadStream(filePath, {
        encoding: null,
        start: chunk.bstart,
        end: chunk.bend + 1
      })
    }, function (error, response, body) {
      if (error) {
        console.log(`Upload chunk failed, Error from request module: ${error.message}`);
        return reject(error);
      }

      let headers = response.headers;
      if (headers && headers.range) {
        let range = parseRange(headers.range);
        if (range && range.last != chunk.bend) {
          // range is diff, need to return to recreate chunks
          return resolve(range);
        }
      }

      if (!body) {
        console.log(`Upload chunk return empty body.`);
        return resolve(null);
      }

      body = JSON.parse(body);
      if (body && body.id) {
        return resolve(body.id);
      } else {
        console.log(`Got file id null`);
        return resolve(null);
      }
    });
  });
}

/**
   * Upload a file to google drive: Passed
   * @param {function} file
   * @param {string} file.filePath
   * @param {string} file.mimeType
   * @returns {path} File's path
   */
function uploadGoogleDriveFile (parent, file) {
  var fileName = file.filePath.substring(file.filePath.lastIndexOf('/') + 1);
  return new Promise((resolve, reject) => {
    var size = fs.statSync(file.filePath).size;
    driveAuth.call((err, auth) => {
      if (err) {
        return reject(new Error('Failed to get OAuth client'));
      }
      auth.getAccessToken().then(token => {
        token = token['token'];
        let options = {
          method: 'POST',
          url: 'https://www.googleapis.com/upload/drive/v3/files',
          qs: { uploadType: 'resumable' },
          headers:
           { 'Postman-Token': '1d58fdd0-0408-45fa-a45d-fc703bff724a',
             'Cache-Control': 'no-cache',
             'X-Upload-Content-Length': size,
             'X-Upload-Content-Type': file.mimeType,
             'Content-Type': 'application/json',
             'Authorization': `Bearer ${token}` },
          body: {
            name: fileName,
            mimeType: file.mimeType,
            parents: [parent]},
          json: true
        };

        request(options, async function (error, response, body) {
          if (error) {
            return reject(error);
          }

          if (!response) {
            return reject(new Error(`Get drive resumable url return undefined headers`));
          }

          if (!response.headers || !response.headers.location || response.headers.location.length <= 0) {
            return reject(new Error(`Get drive resumable url return invalid headers: ${JSON.stringify(response.headers, null, 2)}`));
          }

          console.log(`Uploading file ${fileName} to Google drive.`);
          let chunks = getChunks(file.filePath, 0);
          let fileId = null;
          try {
            let i = 0;
            while (i < chunks.length) {
              // last chunk will return the file id
              fileId = await uploadChunk(file.filePath, chunks[i], file.mineType, response.headers.location);
              if ((typeof fileId === 'object') && (fileId !== null)) {
                chunks = getChunks(file.filePath, fileId.last);
                i = 0;
              } else {
                i++;
              }
            }

            if (fileId && fileId.length > 0) {
              console.log('Upload complete');
              return resolve(fileId);
            } else {
              return reject(new Error('Uploaded and got invalid id for file ' + fileName));
            }
          } catch (er) {
            console.log(`Uploading chunks for file ${fileName} failed: ${er.message}`);
            return reject(er);
          }
        });
      }).catch(err => {
        console.log('Sending request to get resumable url: ' + err.message);
        return reject(err);
      });
    });
  });
}

module.exports.uploadGoogleDriveFile = uploadGoogleDriveFile;
