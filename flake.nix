{
  description = "GNOME 49 USBGuard prompt extension (allow/block once or permanently)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

        extensionUuid = "usbguard-prompt@blacksheeep";
        gnomeShellVersion = "49";
        releaseZipTool = pkgs.writeShellApplication {
          name = "usbguard-release-zip";
          runtimeInputs = with pkgs; [
            coreutils
            findutils
            gnome-extensions-cli
            gnugrep
            jq
            zip
          ];
          text = ''
            set -euo pipefail
            repo_root="''${1:-$PWD}"
            exec ${pkgs.bash}/bin/bash ${./scripts/release-zip.sh} "$repo_root"
          '';
        };
      in
      {
        packages.default = pkgs.stdenvNoCC.mkDerivation {
          pname = "gnome-shell-extension-usbguard-prompt";
          version = "0.1.0";
          src = self;

          dontBuild = true;

          installPhase = ''
            runHook preInstall
            target="$out/share/gnome-shell/extensions/${extensionUuid}"
            mkdir -p "$target"
            cp -r extension/* "$target/"
            runHook postInstall
          '';

          passthru = {
            inherit extensionUuid gnomeShellVersion;
          };

          meta = with pkgs.lib; {
            description = "GNOME Shell extension prompting USBGuard decisions for inserted USB devices";
            license = licenses.gpl3Only;
            platforms = platforms.linux;
          };
        };

        apps.install = {
          type = "app";
          program = toString (pkgs.writeShellScript "install-usbguard-extension" ''
            set -euo pipefail

            UUID="${extensionUuid}"
            TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"
            EXTENSION_SRC="${self}/extension"

            mkdir -p "$TARGET"
            cp -r "$EXTENSION_SRC/." "$TARGET/"

            echo "Installed extension into $TARGET"
            echo "Restart GNOME Shell (or log out/in), then enable:"
            echo "  gnome-extensions enable $UUID"
          '');
        };

        apps.release-zip = {
          type = "app";
          program = "${releaseZipTool}/bin/usbguard-release-zip";
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            gjs
            glib
            gtk4
            libadwaita
            gnome-shell
            gnome-extensions-cli
            jq
            usbguard
          ];
        };

        formatter = pkgs.nixfmt-rfc-style;
      });
}
