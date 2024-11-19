let port;
let reader;
let writer;
let outputElement = document.getElementById("output");
let deviceGridElement = document.getElementById("deviceGrid");
let connectButton = document.getElementById("connectButton");
let resetButton = document.getElementById("resetButton");
let deviceAddresses = [];
let deviceTemperatures = {};
let connectedDevices = {};
let confirmationRetries = {};
let errorCounters = {}; // Track errors for each device
let discoveryAttempts = 0;
const maxDiscoveryAttempts = 1000;
const waitTime = 100;
const connectedMessageRetries = 3;
const maxErrorCount = 5; // Maximum allowed errors before skipping a device
let currentDeviceIndex = 0; // Track the current device for temperature sampling
let isSampling = false; // Flag to ensure sampling is continuous
let serialBuffer = ""; // Buffer to hold incoming serial data

function calculateCRC(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xFFFF;
    }
  }
  return crc;
}

async function connectSerial() {
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 1000000 });

    reader = port.readable.getReader();
    writer = port.writable.getWriter();

    outputElement.textContent += "Connected to Serial Device\n";
    resetDiscovery();
    setTimeout(startDiscovery, 2000);

    resetButton.disabled = false;
    connectButton.disabled = true;
    readSerialData();
  } catch (error) {
    console.error("Error:", error);
    outputElement.textContent += "Error: " + error + "\n";
  }
}

async function readSerialData() {
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reader.releaseLock();
        break;
      }
      if (value) {
        serialBuffer += new TextDecoder().decode(value);
        processSerialBuffer();
      }
    }
  } catch (error) {
    console.error("Read error:", error);
    outputElement.textContent += "Read error: " + error + "\n";
  }
}

function processSerialBuffer() {
  let lines = serialBuffer.split("\n");
  serialBuffer = lines.pop(); // Keep the incomplete line in the buffer

  lines.forEach((line) => {
    handleSerialData(line.trim());
  });
}
function handleSerialData(data) {
  if (!data) return; // Ignore empty messages

  // Add the new message to the output
  outputElement.textContent += "Received: " + data + "\n";

  // Limit the number of lines to 100
  const lines = outputElement.textContent.split("\n");
  if (lines.length > 100) {
    outputElement.textContent = lines.slice(lines.length - 100).join("\n");
  }

  // Scroll to the bottom to show the latest message
  outputElement.scrollTop = outputElement.scrollHeight;

  const separatorIndex = data.lastIndexOf(',');
  if (separatorIndex === -1) {
    outputElement.textContent += "Invalid data format (no CRC)\n";
    outputElement.scrollTop = outputElement.scrollHeight;
    handleCorruptedData();
    return;
  }

  const message = data.substring(0, separatorIndex);
  const receivedCRC = parseInt(data.substring(separatorIndex + 1), 16);
  const calculatedCRC = calculateCRC(message);

  if (calculatedCRC !== receivedCRC) {
    outputElement.textContent += "CRC check failed\n";
    outputElement.scrollTop = outputElement.scrollHeight;
    handleCorruptedData();
    return;
  }

  // Check if the message contains temperature data
  if (message.includes(",")) {
    const [address, tempData] = message.split(",");

    // If it's a temperature reading, update the temperature for the existing device
    if (deviceAddresses.includes(address)) {
      deviceTemperatures[address] = tempData;
      errorCounters[address] = 0; // Reset error counter on successful read
      updateDeviceGrid();
      // Move to the next device in the queue
      currentDeviceIndex = (currentDeviceIndex + 1) % deviceAddresses.length;
      // Schedule the next temperature request
      if (isSampling) {
        setTimeout(requestTemperature, waitTime);
      }
      return;
    }
  }

  // Otherwise, treat it as a device address
  if (!connectedDevices[message] && !deviceAddresses.includes(message)) {
    deviceAddresses.push(message);
    deviceTemperatures[message] = "N/A";
    errorCounters[message] = 0; // Initialize error counter
    confirmationRetries[message] = 0;
    connectedDevices[message] = false;
    sendConnectedMessage(message);
    updateDeviceGrid();
  }
}


function handleCorruptedData() {
  const address = deviceAddresses[currentDeviceIndex];
  if (!address) return;

  // Increment the error counter for the current device
  errorCounters[address] = (errorCounters[address] || 0) + 1;

  if (errorCounters[address] > maxErrorCount) {
    outputElement.textContent += `Too many errors for device ${address}. Skipping...\n`;
    currentDeviceIndex = (currentDeviceIndex + 1) % deviceAddresses.length;
  }

  // Schedule the next temperature request after a short delay
  setTimeout(requestTemperature, waitTime);
}

async function sendConnectedMessage(address) {
  for (let i = 0; i < connectedMessageRetries; i++) {
    const confirmationMessage = address + ",CONNECTED";
    const crc = calculateCRC(confirmationMessage);
    writer.write(new TextEncoder().encode(`${confirmationMessage},${crc.toString(16).toUpperCase()}\n`));
    outputElement.textContent += `Sent: ${confirmationMessage},CRC (Retry ${i + 1})\n`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  connectedDevices[address] = true;
}

function updateDeviceGrid() {
  deviceGridElement.innerHTML = "";
  deviceAddresses.forEach((address, index) => {
    const status = connectedDevices[address] ? "Connected" : "Pending";
    deviceGridElement.innerHTML += `<div>Device ${index + 1}: ${address} - Temp: ${deviceTemperatures[address]} - Status: ${status}</div>`;
  });
}

function startDiscovery() {
  if (discoveryAttempts >= maxDiscoveryAttempts) {
    outputElement.textContent += "Max discovery attempts reached. Stopping discovery.\n";
    return;
  }

  discoveryAttempts++;
  const message = "DISCOVER";
  const crc = calculateCRC(message);
  writer.write(new TextEncoder().encode(`${message},${crc.toString(16).toUpperCase()}\n`));
  outputElement.textContent += "Sent: " + message + ",CRC\n";

  setTimeout(() => {
    if (deviceAddresses.length < 4) {
      outputElement.textContent += `Retrying discovery (Attempt ${discoveryAttempts})...\n`;
      startDiscovery();
    } else {
      outputElement.textContent += "All devices connected. Discovery complete.\n";
      isSampling = true; // Start sampling temperatures
      requestTemperature(); // Start temperature sampling
    }
  }, waitTime);
}

function resetDiscovery() {
  const message = "RESET";
  const crc = calculateCRC(message);
  writer.write(new TextEncoder().encode(`${message},${crc.toString(16).toUpperCase()}\n`));
  outputElement.textContent += "Sent: " + message + ",CRC\n";

  deviceAddresses = [];
  deviceTemperatures = {};
  connectedDevices = {};
  confirmationRetries = {};
  errorCounters = {}; // Reset error counters
  discoveryAttempts = 0;
  currentDeviceIndex = 0;
  isSampling = false; // Stop sampling temperatures
  updateDeviceGrid();
  outputElement.textContent += "Reset command sent. Discovery process reset.\n";

  setTimeout(startDiscovery, 1000);
}

function requestTemperature() {
  if (deviceAddresses.length === 0 || !isSampling) return;

  const address = deviceAddresses[currentDeviceIndex];
  const message = `${address},READTEMP`;
  const crc = calculateCRC(message);
  writer.write(new TextEncoder().encode(`${message},${crc.toString(16).toUpperCase()}\n`));
  outputElement.textContent += `Sent: ${message},CRC\n`;
}

setup();

function setup() {
  connectButton.addEventListener("click", connectSerial);
  resetButton.addEventListener("click", resetDiscovery);
}
