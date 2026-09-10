import XCTest

final class DriverOnboardingTests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testPairingScreenDoesNotRequireAnExistingAccountOrSubmitAutomatically() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Device setup"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.textFields["Code from fleet manager"].exists)
        XCTAssertTrue(app.secureTextFields["Driver PIN"].exists)
        let pair = app.buttons["Pair device"]
        XCTAssertTrue(pair.exists)
        XCTAssertFalse(pair.isEnabled)
        saveScreenshot("pairing-portrait")
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.textFields["Code from fleet manager"].waitForExistence(timeout: 5))
        saveScreenshot("pairing-landscape")
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
    }

    func testPairingAtAccessibilityTextSize() {
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Device setup"].waitForExistence(timeout: 20))
        app.swipeUp()
        saveScreenshot("pairing-large-text")
        app.terminate()
    }

    private func saveScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
