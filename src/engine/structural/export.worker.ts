import { exportPng } from './export-png';
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ blob: await exportPng(data.marks, data.w, data.h, data.white) });
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
