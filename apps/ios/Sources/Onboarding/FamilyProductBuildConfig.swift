import Foundation

enum FamilyProductBuildConfig {
    static var isEnabled: Bool {
        self.isEnabled(value: Bundle.main.object(forInfoDictionaryKey: "OpenClawFamilyProduct"))
    }

    static func isEnabled(value: Any?) -> Bool {
        if let boolean = value as? Bool {
            return boolean
        }
        return (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "yes"
    }
}
