# typed: false
# frozen_string_literal: true

# Homebrew cask for WordBrain — local-first English vocabulary builder.
#
# Install with:
#   brew install --cask lifefarmer/tap/wordbrain
#
# Maintained alongside the GitHub release pipeline — bump `version` + `sha256`
# when a new release is cut (handled by scripts/publish.sh post-release).
cask "wordbrain" do
  version "0.1.0"
  sha256 :no_check # fill in after the first signed dmg is uploaded

  url "https://github.com/lifefarmer/wordbrain/releases/download/v#{version}/WordBrain_#{version}_universal.dmg"
  name "WordBrain"
  desc "Local-first English vocabulary builder with word-network graphs and FSRS review"
  homepage "https://github.com/lifefarmer/wordbrain"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true

  app "WordBrain.app"

  zap trash: [
    "~/Library/Application Support/com.lifefarmer.wordbrain",
    "~/Library/Caches/com.lifefarmer.wordbrain",
    "~/Library/Preferences/com.lifefarmer.wordbrain.plist",
    "~/Library/Saved Application State/com.lifefarmer.wordbrain.savedState"
  ]
end
