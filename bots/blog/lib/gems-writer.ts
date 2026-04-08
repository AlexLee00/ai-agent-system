const gemsWriterModule = require('./gems-writer.js') as typeof import('./gems-writer.js');

export const {
  writeGeneralPost,
  writeGeneralPostChunked,
  repairGeneralPostDraft,
  GEMS_SYSTEM_PROMPT,
} = gemsWriterModule;
