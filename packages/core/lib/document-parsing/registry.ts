// @ts-nocheck
'use strict';

const textExtractor = require('./extractors/text.ts');
const xlsxExtractor = require('./extractors/xlsx.ts');
const docxExtractor = require('./extractors/docx.ts');
const docExtractor = require('./extractors/doc.ts');
const pptxExtractor = require('./extractors/pptx.ts');
const imageExtractor = require('./extractors/image.ts');
const pdfExtractor = require('./extractors/pdf.ts');

function createExtractorRegistry() {
  const extractors = [
    pdfExtractor,
    textExtractor,
    xlsxExtractor,
    docxExtractor,
    docExtractor,
    pptxExtractor,
    imageExtractor,
  ];

  return {
    list() {
      return extractors.slice();
    },
    resolve(context) {
      return extractors.find((extractor) => extractor.canHandle(context)) || null;
    },
  };
}

module.exports = {
  createExtractorRegistry,
};
