/**
 * roboflow_accident_infer.js
 * Run inference using Roboflow's Serverless Cloud API on model "accident-detection-eamy3/1"
 *
 * Usage:
 *   node roboflow_accident_infer.js [optional_image_path]
 *
 * Examples:
 *   node roboflow_accident_infer.js
 *   node roboflow_accident_infer.js test_cap.jpg
 */

const fs = require("fs");
const path = require("path");
const envPath = fs.existsSync(path.join(__dirname, ".env")) ? path.join(__dirname, ".env") : path.join(__dirname, "..", ".env");
require("dotenv").config({ path: envPath });

const API_KEY = process.env.ROBOFLOW_API_KEY;
const MODEL_ID = process.env.ROBOFLOW_ACCIDENT_MODEL_ID || "accident-detection-eamy3/1";

async function runAccidentInference(imagePathOrUrl) {
  if (!API_KEY) {
    console.error("[-] Error: ROBOFLOW_API_KEY is not set in .env!");
    process.exit(1);
  }

  let bodyData;
  let targetUrl = `https://serverless.roboflow.com/${MODEL_ID}`;

  // Check if argument is a URL or a local file
  if (imagePathOrUrl && (imagePathOrUrl.startsWith("http://") || imagePathOrUrl.startsWith("https://"))) {
    targetUrl += `?image=${encodeURIComponent(imagePathOrUrl)}`;
    bodyData = "";
  } else {
    // Read local file or default to scratch/test image if available
    const targetFile = imagePathOrUrl || path.join(__dirname, "test_cap.jpg");

    if (!fs.existsSync(targetFile)) {
      console.error(`[-] Error: Local image file not found: ${targetFile}`);
      console.error("[-] Pass an image path, e.g.: node roboflow_accident_infer.js my_photo.jpg");
      process.exit(1);
    }

    console.log(`[+] Reading local image: ${targetFile}`);
    bodyData = fs.readFileSync(targetFile, { encoding: "base64" });
  }

  console.log(`[+] Calling Roboflow Serverless API: ${MODEL_ID}...`);

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: bodyData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Request failed with status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    console.log("\n================ ROBOFLOW ACCIDENT INFERENCE RESULT ================");
    console.log(JSON.stringify(data, null, 2));
    console.log("====================================================================\n");

    if (data.predictions && data.predictions.length > 0) {
      console.log(`[!] Detected ${data.predictions.length} accident / collision object(s):`);
      data.predictions.forEach((p, idx) => {
        console.log(`    #${idx + 1}: ${p.class} (${(p.confidence * 100).toFixed(1)}%) at [x:${p.x}, y:${p.y}, w:${p.width}, h:${p.height}]`);
      });
    } else {
      console.log("[i] No road accident or collision detected in this image.");
    }

    return data;
  } catch (error) {
    console.error("[-] Inference Error:", error.message);
  }
}

// If executed directly from CLI
if (require.main === module) {
  const inputArg = process.argv[2];
  runAccidentInference(inputArg);
}

module.exports = { runAccidentInference };

