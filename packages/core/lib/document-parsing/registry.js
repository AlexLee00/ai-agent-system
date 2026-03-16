'use strict';

const textExtractor = require('./extractors/text');
const xlsxExtractor = require('./extractors/xlsx');
const pptxExtractor = require('./extractors/pptx');
const imageExtractor = require('./extractors/image');
const pdfExtractor = require('./extractors/pdf');

function createExtractorRegistry() {
  const extractors = [
    pdfExtractor,
    textExtractor,
    xlsxExtractor,
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
