const posWriterModule = require('./pos-writer.js') as typeof import('./pos-writer.js');

export const {
  writeLecturePost,
  writeLecturePostChunked,
  repairLecturePostDraft,
  POS_SYSTEM_PROMPT,
} = posWriterModule;
