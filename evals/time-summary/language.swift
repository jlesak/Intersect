import Foundation
import NaturalLanguage

let data = FileHandle.standardInput.readDataToEndOfFile()
let values = (try JSONSerialization.jsonObject(with: data)) as! [String]
let languages = values.map { text -> String in
  let recognizer = NLLanguageRecognizer()
  recognizer.processString(text)
  return recognizer.dominantLanguage?.rawValue ?? "unknown"
}
let output = try JSONSerialization.data(withJSONObject: languages)
FileHandle.standardOutput.write(output)
