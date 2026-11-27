'use strict';
// one worker thread for main/library-fs.js, so launch-time library reads stop holding the main
// process (and with it every click and scroll in the window). built from inline source with
// eval like main/clip-media.js, loading a worker file out of app.asar is not something to rely on.
// any trouble with the worker and the same functions run in-process instead.
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const libraryFs = require('./library-fs');

// the sources the worker gets, by the name library-fs requires them under
const SOURCES = { './read-retry': 'read-retry.js', './library-fs': 'library-fs.js' };
// a worker that died this often runs nothing more this session
const MAX_CRASHES = 3;

let worker = null;
let crashes = 0;
let nextId = 1;
const pending = new Map();

function bootstrapCode() {
  const sources = {};
  for (const [name, file] of Object.entries(SOURCES)) {
    sources[name] = fs.readFileSync(path.join(__dirname, file), 'utf8');
  }
  return `'use strict';
const { parentPort } = require('worker_threads');
const sources = ${JSON.stringify(sources)};
const cache = {};
function load(name) {
  if (cache[name]) return cache[name].exports;
  const module = { exports: {} };
  cache[name] = module;
  new Function('module', 'exports', 'require', sources[name])(module, module.exports, (dep) => (sources[dep] ? load(dep) : require(dep)));
  return module.exports;
}
const { jobs } = load('./library-fs');
parentPort.on('message', async ({ id, job, args }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: await jobs[job](args) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { message: String(error && error.message), code: error && error.code } });
  }
});`;
}

function failAll(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function ensureWorker() {
  // CLIPLIB_LIBRARY_WORKER=0 reads in-process, for benches comparing the two
  if (process.env.CLIPLIB_LIBRARY_WORKER === '0') return null;
  if (worker || crashes >= MAX_CRASHES) return worker;
  try {
    worker = new Worker(bootstrapCode(), { eval: true });
  } catch (error) {
    crashes = MAX_CRASHES;
    logger.warn(`[library-worker] could not start, reading in-process: ${error.message}`);
    return null;
  }
  worker.on('message', ({ id, ok, result, error }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (pending.size === 0) worker.unref();
    if (ok) call.resolve(result);
    else call.reject(Object.assign(new Error(error.message), { code: error.code, fromJob: true }));
  });
  const lost = (reason) => {
    worker = null;
    crashes += 1;
    logger.warn(`[library-worker] ${reason}, ${crashes >= MAX_CRASHES ? 'reading in-process from now on' : 'restarts on next use'}`);
    failAll(Object.assign(new Error(`library worker ${reason}`), { workerLost: true }));
  };
  worker.on('error', (error) => lost(`crashed: ${error.message}`));
  worker.on('exit', (code) => { if (worker) lost(`exited with ${code}`); });
  // only held while a job runs: idle it must not keep the process alive at quit. after the
  // listeners, adding a message listener refs it again
  worker.unref();
  return worker;
}

/**
 * runs a library-fs job off the main thread; errors the job itself throws come back as they
 * are, a lost worker falls back to running the job here
 * @param {keyof typeof libraryFs.jobs} job
 */
async function run(job, args) {
  const w = ensureWorker();
  if (!w) return libraryFs.jobs[job](args);
  try {
    return await new Promise((resolve, reject) => {
      const id = nextId++;
      if (pending.size === 0) w.ref();
      pending.set(id, { resolve, reject });
      w.postMessage({ id, job, args });
    });
  } catch (error) {
    if (!error.workerLost) throw error;
    return libraryFs.jobs[job](args);
  }
}

module.exports = { run };
