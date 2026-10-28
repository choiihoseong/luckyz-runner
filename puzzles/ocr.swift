// 사용: ocr <png> <x> <y> <w> <h>  (픽셀) → 인식된 글자 줄들을 왼쪽→오른쪽 순으로 출력
import Foundation
import Vision
import AppKit
let a = CommandLine.arguments
guard a.count == 6, let img = NSImage(contentsOfFile: a[1]), var cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
if let c = cg.cropping(to: CGRect(x: Double(a[2])!, y: Double(a[3])!, width: Double(a[4])!, height: Double(a[5])!)) { cg = c }
let req = VNRecognizeTextRequest(); req.recognitionLevel = .accurate; req.usesLanguageCorrection = false
try? VNImageRequestHandler(cgImage: cg).perform([req])
let obs = (req.results ?? []).sorted { $0.boundingBox.minX < $1.boundingBox.minX }
for o in obs { if let t = o.topCandidates(1).first { print(t.string) } }
