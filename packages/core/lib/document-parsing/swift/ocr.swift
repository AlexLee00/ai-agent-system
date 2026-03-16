import Foundation
import Vision
import AppKit
import PDFKit

struct LineResult: Codable {
    let text: String
    let confidence: Double
}

struct OcrPageResult: Codable {
    let index: Int
    let text: String
    let confidence: Double?
    let width: Int?
    let height: Int?
    let warnings: [String]
}

struct NativePdfResult: Codable {
    let pageCount: Int
    let pages: [OcrPageResult]
}

func loadCGImage(from filePath: String) -> CGImage? {
    guard let nsImage = NSImage(contentsOfFile: filePath) else { return nil }
    var rect = CGRect(origin: .zero, size: nsImage.size)
    return nsImage.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func renderPdfPage(_ page: PDFPage, scale: CGFloat = 2.0) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let width = max(Int(bounds.width * scale), 1)
    let height = max(Int(bounds.height * scale), 1)
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.saveGState()
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: scale, y: -scale)
    page.draw(with: .mediaBox, to: context)
    context.restoreGState()
    return context.makeImage()
}

func recognizeText(from image: CGImage) throws -> (String, Double?, [String], Int, Int) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let warnings = NSMutableArray(array: [])
    let width = image.width
    let height = image.height

    if width < 900 || height < 900 {
        warnings.add("image_quality_low")
    }

    var lines: [LineResult] = []
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        lines.append(LineResult(text: candidate.string, confidence: Double(candidate.confidence)))
    }

    let text = lines.map { $0.text }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    let avgConfidence = lines.isEmpty ? nil : lines.map(\.confidence).reduce(0, +) / Double(lines.count)

    if text.isEmpty {
        warnings.add("image_text_not_found")
    }
    if let avgConfidence, avgConfidence < 0.55 {
        warnings.add("image_ocr_low_confidence")
    }

    return (text, avgConfidence, warnings.compactMap { $0 as? String }, width, height)
}

func runImageMode(_ filePath: String) throws {
    guard let image = loadCGImage(from: filePath) else {
        throw NSError(domain: "ocr", code: 1, userInfo: [NSLocalizedDescriptionKey: "unable_to_load_image"])
    }
    let result = try recognizeText(from: image)
    let payload = OcrPageResult(index: 1, text: result.0, confidence: result.1, width: result.3, height: result.4, warnings: result.2)
    let data = try JSONEncoder().encode(payload)
    FileHandle.standardOutput.write(data)
}

func runPdfNativeMode(_ filePath: String) throws {
    guard let document = PDFDocument(url: URL(fileURLWithPath: filePath)) else {
        throw NSError(domain: "ocr", code: 2, userInfo: [NSLocalizedDescriptionKey: "unable_to_open_pdf"])
    }
    var pages: [OcrPageResult] = []
    for index in 0..<document.pageCount {
        let page = document.page(at: index)
        let text = page?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        pages.append(OcrPageResult(index: index + 1, text: text, confidence: nil, width: nil, height: nil, warnings: []))
    }
    let data = try JSONEncoder().encode(NativePdfResult(pageCount: document.pageCount, pages: pages))
    FileHandle.standardOutput.write(data)
}

func runPdfOcrMode(_ filePath: String) throws {
    guard let document = PDFDocument(url: URL(fileURLWithPath: filePath)) else {
        throw NSError(domain: "ocr", code: 3, userInfo: [NSLocalizedDescriptionKey: "unable_to_open_pdf"])
    }
    var pages: [OcrPageResult] = []
    for index in 0..<document.pageCount {
        guard let page = document.page(at: index),
              let image = renderPdfPage(page)
        else {
            pages.append(OcrPageResult(index: index + 1, text: "", confidence: nil, width: nil, height: nil, warnings: ["ocr_failed"]))
            continue
        }
        let result = try recognizeText(from: image)
        let warnings = Array(Set(result.2 + ["ocr_based_source"]))
        pages.append(OcrPageResult(index: index + 1, text: result.0, confidence: result.1, width: result.3, height: result.4, warnings: warnings))
    }
    let data = try JSONEncoder().encode(NativePdfResult(pageCount: document.pageCount, pages: pages))
    FileHandle.standardOutput.write(data)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("usage: ocr.swift <image-ocr|pdf-native|pdf-ocr> <path>\n", stderr)
    exit(1)
}

let mode = args[1]
let filePath = args[2]

do {
    switch mode {
    case "image-ocr":
        try runImageMode(filePath)
    case "pdf-native":
        try runPdfNativeMode(filePath)
    case "pdf-ocr":
        try runPdfOcrMode(filePath)
    default:
        fputs("unsupported_mode\n", stderr)
        exit(2)
    }
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(3)
}
