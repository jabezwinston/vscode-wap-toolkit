# Build VSCode extension and install it

#!/bin/bash
set -e
# Check if the required tools are installed
if ! command -v vsce &> /dev/null; then
    echo "vsce could not be found. Please install it first."
    exit 1
fi

# Check if the current directory is a valid VSCode extension
if [ ! -f package.json ]; then
    echo "This script must be run in the root directory of a VSCode extension."
    exit 1
fi

# Build the extension
echo "Building the VSCode extension..."
vsce package
if [ $? -ne 0 ]; then
    echo "Failed to build the extension."
    exit 1
fi
# Install the extension
echo "Installing the VSCode extension..."
code --install-extension *.vsix
if [ $? -ne 0 ]; then
    echo "Failed to install the extension."
    exit 1
fi

echo "VSCode extension built and installed successfully."
