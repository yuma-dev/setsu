'use strict';
const fs = require('fs').promises;

// out of handles (a launch-time fan-out over the library) or a file another process holds for a
// moment; both clear up on their own, so a failed read here says nothing about the file
const TRANSIENT = new Set(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN']);
const DELAYS_MS = [50, 200, 600];

function isTransient(error) {
  return TRANSIENT.has(error?.code);
}

async function readFileRetry(filePath, encoding = 'utf8') {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(filePath, encoding);
    } catch (error) {
      if (!isTransient(error) || attempt >= DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, DELAYS_MS[attempt]));
    }
  }
}

module.exports = { readFileRetry, isTransient };
