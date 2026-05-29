#!/usr/bin/env swift
import Foundation
import Vision
import AppKit

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let paths = Array(CommandLine.arguments.dropFirst())
if paths.isEmpty {
    fail("usage: claude-image-ocr.swift <image-path> [image-path...]", code: 2)
}

struct OCRResult: Encodable {
    let path: String
    let text: String
    let lineCount: Int
}

var results: [OCRResult] = []

for rawPath in paths {
    let imageURL = URL(fileURLWithPath: rawPath)
    guard let image = NSImage(contentsOf: imageURL),
          let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let cgImage = bitmap.cgImage else {
        fail("failed to load image: \(rawPath)", code: 3)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("ocr error for \(rawPath): \(error)", code: 4)
    }

    let lines = (request.results ?? []).compactMap { observation in
        observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty }

    results.append(OCRResult(path: rawPath, text: lines.joined(separator: "\n"), lineCount: lines.count))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
let data = try encoder.encode(results)
FileHandle.standardOutput.write(data)
