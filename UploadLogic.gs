/**
 * Configuration constants for Script Properties.
 * Go to File > Project properties > Script properties to set these.
 */
const CONFIG = {
  LML_BASE_URL: 'LML_BASE_URL', // e.g., https://api.lml.live
  LML_SESSION_ID: 'LML_SESSION_ID', // Value of _lml_session cookie
  SHEET_NAME: 'SHEET_NAME', // e.g., Gig data entry - This week
  DATA_RANGE: 'DATA_RANGE', // e.g., A2:G (adjust columns as needed)
  DUPLICATE_LOOKAHEAD_DAYS: 'DUPLICATE_LOOKAHEAD_DAYS', // e.g., 30
  QUERY_LOCATION: 'QUERY_LOCATION' // e.g., melbourne
};

/**
 * Column names for feedback. These will be added if they don't exist.
 */
const FEEDBACK_COLS = {
  STATUS: "Upload Status",
  ID: "Upload ID",
  ERROR: "Upload Error"
};

/**
 * Main function triggered by the menu item.
 * Orchestrates the process of checking duplicates and uploading gigs.
 */
function uploadGigsWithCheck() {
  const ui = SpreadsheetApp.getUi();
  const scriptProperties = PropertiesService.getScriptProperties();
  const props = scriptProperties.getProperties();

  // --- 1. Configuration Validation ---
  // Define the NAMES of the required properties
  const requiredPropNames = [
    'LML_BASE_URL', 'LML_SESSION_ID', 'SHEET_NAME',
    'DATA_RANGE', 'DUPLICATE_LOOKAHEAD_DAYS', 'QUERY_LOCATION'
  ];
  // Check if each required property NAME exists as a key in the fetched props object
  const missingPropNames = requiredPropNames.filter(name => !props.hasOwnProperty(name) || !props[name]);
  if (missingPropNames.length > 0) {
    // Report the missing NAMES
    ui.alert("Configuration Error", `Missing Script Properties: ${missingPropNames.join(', ')}. Please set them via File > Project properties > Script properties.`, ui.ButtonSet.OK);
    return;
  }
  // Now safely access the properties using their names
  const lookaheadDays = parseInt(props['DUPLICATE_LOOKAHEAD_DAYS'], 10);
  if (isNaN(lookaheadDays)) {
     ui.alert("Configuration Error", `Invalid value for DUPLICATE_LOOKAHEAD_DAYS. Must be a number.`, ui.ButtonSet.OK);
     return;
  }

  const baseUrl = props[CONFIG.LML_BASE_URL].replace(/\/$/, ''); // Remove trailing slash
  const sessionId = props[CONFIG.LML_SESSION_ID];
  const sheetName = props[CONFIG.SHEET_NAME];
  const dataRangeNotation = props[CONFIG.DATA_RANGE];
  const queryLocation = props[CONFIG.QUERY_LOCATION];

  // --- 2. Sheet and Range Setup ---
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    ui.alert("Error", `Sheet named "${sheetName}" not found.`, ui.ButtonSet.OK);
    return;
  }
  const dataRange = sheet.getRange(dataRangeNotation);
  // Read header row dynamically based on data range start column and sheet's last column
  const headerRange = sheet.getRange(dataRange.getRow() -1, dataRange.getColumn(), 1, sheet.getLastColumn() - dataRange.getColumn() + 1);
  const headerRowValues = headerRange.getValues()[0];
  const headers = headerRowValues.map(h => String(h).toLowerCase().trim()); // Use actual headers read

  // --- 3. Ensure Feedback Columns & Map Indices ---
   Logger.log("Ensuring feedback columns exist...");
  const feedbackColIndices = ensureFeedbackColumnsExist(sheet, headers); // Pass mutable headers array
   Logger.log(`Feedback column indices: Status=${feedbackColIndices.status}, ID=${feedbackColIndices.id}, Error=${feedbackColIndices.error}`);

  // Map required data columns needed for validation/duplicate check
  const requiredDataCols = ['venue_id', 'date', 'time', 'name']; // Use actual CSV headers (lowercase)
  const colIndices = {};
  requiredDataCols.forEach(colName => {
    const index = headers.indexOf(colName);
    if (index === -1) {
      // Throw error immediately if essential columns for logic are missing
      throw new Error(`Required column "${colName}" not found in sheet headers.`);
    }
    // Store index using a key derived from colName (e.g., venue_id -> venueid)
    colIndices[colName.replace(/[^a-z0-9]/gi, '')] = index;
  });
   Logger.log(`Mapped essential data column indices: ${JSON.stringify(colIndices)}`);


  // --- 4. Clear Previous Feedback ---
   Logger.log("Clearing previous feedback...");
  const firstRow = dataRange.getRow();
  const numRows = dataRange.getNumRows();
  if (numRows > 0) {
      if (feedbackColIndices.status !== -1) sheet.getRange(firstRow, feedbackColIndices.status + 1, numRows, 1).clearContent();
      if (feedbackColIndices.id !== -1) sheet.getRange(firstRow, feedbackColIndices.id + 1, numRows, 1).clearContent();
      if (feedbackColIndices.error !== -1) sheet.getRange(firstRow, feedbackColIndices.error + 1, numRows, 1).clearContent();
      SpreadsheetApp.flush(); // Apply changes immediately
  } else {
      Logger.log("No data rows found in range.");
      ui.alert("Info", "No data rows found in the specified range.", ui.ButtonSet.OK);
      return;
  }


  // --- 5. Get Sheet Data ---
   Logger.log("Reading sheet data...");
  const sheetData = dataRange.getValues(); // Raw data (includes Date objects)
  const displayData = dataRange.getDisplayValues(); // Display strings

  // --- 6. Find Potential Duplicates ---
   Logger.log("Checking for potential duplicates via API...");
  try {
    // Pass the actual headers array read from the sheet
    findPotentialDuplicates(sheet, sheetData, headers, colIndices, feedbackColIndices, lookaheadDays, queryLocation, baseUrl);
    SpreadsheetApp.flush(); // Write duplicate statuses
     Logger.log("Duplicate check complete.");
  } catch (e) {
     Logger.log(`Error during duplicate check: ${e.message}\n${e.stack}`);
     ui.alert("Duplicate Check Error", `Failed to check for duplicates: ${e.message}`, ui.ButtonSet.OK);
     // Optionally write error to sheet here if needed
     return; // Stop if duplicate check fails
  }

  // --- 7. Filter Non-Duplicates & Prepare for Upload ---
   Logger.log("Filtering non-duplicate rows...");
  const rowsToUploadIndices = [];
  const rowsToUploadData = []; // Raw data for non-duplicates
  const rowsToUploadDisplayData = []; // Display data for non-duplicates

  // Re-read status column after potential updates by findPotentialDuplicates
  const statusColData = feedbackColIndices.status !== -1 ? sheet.getRange(firstRow, feedbackColIndices.status + 1, numRows, 1).getValues() : null;

  for (let i = 0; i < numRows; i++) {
    // --- Skip row if essential display data is missing ---
    const displayName = displayData[i][colIndices.name] ? String(displayData[i][colIndices.name]).trim() : '';
    const displayVenueId = displayData[i][colIndices.venueid] ? String(displayData[i][colIndices.venueid]).trim() : '';
    const displayDate = displayData[i][colIndices.date] ? String(displayData[i][colIndices.date]).trim() : '';

    if (!displayName && !displayVenueId && !displayDate) {
       Logger.log(`Skipping empty row ${firstRow + i}`);
       continue; // Skip this row entirely if key fields are blank
    }
    // --- End Skip Row Check ---

    const currentStatus = statusColData ? statusColData[i][0] : '';
    // Check if date is valid before considering upload
    const dateVal = sheetData[i][colIndices.date]; // Use mapped index
     if (!(dateVal instanceof Date) || isNaN(dateVal.getTime())) {
         if (feedbackColIndices.error !== -1 && (!currentStatus || !String(currentStatus).toLowerCase().includes('duplicate'))) { // Only write error if not already marked duplicate
             sheet.getRange(firstRow + i, feedbackColIndices.error + 1).setValue("Invalid or missing date");
         }
         continue; // Skip rows with invalid dates
     }

    if (!currentStatus || !String(currentStatus).toLowerCase().includes('duplicate')) {
      rowsToUploadIndices.push(firstRow + i); // Store original sheet row index (1-based)
      rowsToUploadData.push(sheetData[i]);
      rowsToUploadDisplayData.push(displayData[i]);
    }
  }

  if (rowsToUploadIndices.length === 0) {
     Logger.log("No non-duplicate rows found to upload.");
     ui.alert("Upload Complete", "No new gigs found to upload (all rows were potential duplicates or had errors).", ui.ButtonSet.OK);
     return;
  }
   Logger.log(`Found ${rowsToUploadIndices.length} rows to attempt uploading.`);

  // --- 8. Format Data ---
   Logger.log("Formatting data in Clipper style...");
  let clipperContent = "";
  try {
    // Pass the actual headers array read from the sheet
    clipperContent = formatDataAsClipper(rowsToUploadData, rowsToUploadDisplayData, headers);
  } catch (e) {
     Logger.log(`Error formatting data: ${e.message}\n${e.stack}`);
     ui.alert("Formatting Error", `Failed to format data: ${e.message}`, ui.ButtonSet.OK);
     // Write error back to sheet for all rows intended for upload
     if (feedbackColIndices.error !== -1) {
         rowsToUploadIndices.forEach(rowIndex => {
             // Check if error column is empty before overwriting
             const errorCell = sheet.getRange(rowIndex, feedbackColIndices.error + 1);
             if (!errorCell.getValue()) {
                 errorCell.setValue(`Formatting Error: ${e.message}`);
             }
         });
         SpreadsheetApp.flush();
     }
     return;
  }
   // Logger.log(`Formatted Clipper Content (first 500 chars):\n${clipperContent.substring(0, 500)}...`);


  // --- 9. Fetch CSRF Token ---
   Logger.log("Fetching CSRF token...");
  let csrfToken = null;
  try {
    csrfToken = fetchCsrfToken(baseUrl, sessionId);
    if (!csrfToken) throw new Error("CSRF token not found in form page.");
     Logger.log("CSRF token obtained.");
  } catch (e) {
     Logger.log(`Error fetching CSRF token: ${e.message}\n${e.stack}`);
     ui.alert("Authentication Error", `Failed to get CSRF token: ${e.message}. Check session ID and LML URL.`, ui.ButtonSet.OK);
     // Write error back to sheet
     if (feedbackColIndices.error !== -1) {
         rowsToUploadIndices.forEach(rowIndex => {
             const errorCell = sheet.getRange(rowIndex, feedbackColIndices.error + 1);
             if (!errorCell.getValue()) {
                errorCell.setValue(`CSRF Token Error: ${e.message}`);
             }
         });
         SpreadsheetApp.flush();
     }
     return;
  }

  // --- 10. Submit Data ---
   Logger.log("Submitting data to LML...");
  const sourceLabel = `Google Sheet Upload - ${new Date().toLocaleDateString("sv")}`; // YYYY-MM-DD
  let uploadResult = { success: false, uploadId: null, error: "Submission not attempted" };
  try {
    uploadResult = submitDataToLml(baseUrl, sessionId, csrfToken, sourceLabel, clipperContent);
     Logger.log(`Upload result: ${JSON.stringify(uploadResult)}`);
  } catch (e) {
     Logger.log(`Error submitting data: ${e.message}\n${e.stack}`);
     uploadResult = { success: false, uploadId: null, error: `Submission Error: ${e.message}` };
  }

  // --- 11. Write Final Feedback ---
   Logger.log("Writing final feedback to sheet...");
  const statusValue = uploadResult.success ? FEEDBACK_COLS.STATUS_UPLOADED || "Uploaded" : FEEDBACK_COLS.STATUS_FAILED || "Upload Failed";
  const idValue = uploadResult.success ? uploadResult.uploadId : '';
  const errorValue = uploadResult.success ? '' : uploadResult.error;

  rowsToUploadIndices.forEach(rowIndex => {
    if (feedbackColIndices.status !== -1) sheet.getRange(rowIndex, feedbackColIndices.status + 1).setValue(statusValue);
    if (feedbackColIndices.id !== -1) sheet.getRange(rowIndex, feedbackColIndices.id + 1).setValue(idValue);
    if (feedbackColIndices.error !== -1) sheet.getRange(rowIndex, feedbackColIndices.error + 1).setValue(errorValue); // Overwrite previous errors if upload failed
  });
  SpreadsheetApp.flush();
   Logger.log("Feedback written.");

  // --- 12. Final Alert ---
  const totalProcessed = numRows;
  // Recalculate duplicates based on final status column content
  let duplicatesFound = 0;
  const finalStatusColData = feedbackColIndices.status !== -1 ? sheet.getRange(firstRow, feedbackColIndices.status + 1, numRows, 1).getValues() : null;
  if (finalStatusColData) {
      finalStatusColData.forEach(cell => {
          if (String(cell[0]).toLowerCase().includes('duplicate')) {
              duplicatesFound++;
          }
      });
  }

  const uploadedCount = uploadResult.success ? rowsToUploadIndices.length : 0;
  const failedCount = !uploadResult.success ? rowsToUploadIndices.length : 0;

  let summary = `Processed: ${totalProcessed} rows.\n`;
  summary += `Potential Duplicates Skipped: ${duplicatesFound}\n`;
  if (uploadResult.success) {
    summary += `Successfully Uploaded: ${uploadedCount} rows.\n`;
    if (uploadResult.uploadId) summary += `Upload ID (Batch): ${uploadResult.uploadId}\n`;
  } else {
    summary += `Upload Attempt Failed for ${failedCount} rows.\nError: ${uploadResult.error}\n`;
  }
  ui.alert("Upload Summary", summary, ui.ButtonSet.OK);
   Logger.log("Script finished.");
}


// ===========================================
// Helper Functions
// ===========================================

/**
 * Ensures specified feedback columns exist, adding them if necessary.
 * Modifies the passed headers array in place.
 * Returns an object mapping feedback type ('status', 'id', 'error') to their 0-based column index.
 */
function ensureFeedbackColumnsExist(sheet, headers) { // headers is passed by reference (sort of)
  const indices = { status: -1, id: -1, error: -1 };
  const headerRowIndex = sheet.getRange(PropertiesService.getScriptProperties().getProperty(CONFIG.DATA_RANGE)).getRow() - 1; // Assumes header is right above data
  let currentLastCol = headers.length; // Based on initial read

  Object.keys(FEEDBACK_COLS).forEach(key => {
    const colName = FEEDBACK_COLS[key];
    const lowerColName = colName.toLowerCase().trim();
    // Check against the current state of the headers array
    const existingIndex = headers.findIndex(h => h === lowerColName);

    if (existingIndex !== -1) {
      indices[key.toLowerCase()] = existingIndex;
    } else {
       Logger.log(`Adding missing feedback column: "${colName}"`);
      currentLastCol++;
      sheet.getRange(headerRowIndex, currentLastCol).setValue(colName); // Write header to sheet
      indices[key.toLowerCase()] = currentLastCol - 1; // 0-based index relative to sheet start
      headers.push(lowerColName); // Add to the headers array we are using locally
    }
  });
  return indices;
}

/**
 * Fetches existing gigs from the LML Query API for duplicate checking.
 */
function findPotentialDuplicates(sheet, sheetData, headers, colIndices, feedbackColIndices, lookaheadDays, queryLocation, baseUrl) {
  let minDate = null;
  let maxDate = null;

  // Find date range in sheet data
  sheetData.forEach(row => {
    const dateVal = row[colIndices.date]; // Use mapped index
    if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
      if (!minDate || dateVal < minDate) minDate = dateVal;
      if (!maxDate || dateVal > maxDate) maxDate = dateVal;
    }
  });

  if (!minDate || !maxDate) {
     Logger.log("No valid dates found in sheet data for duplicate check.");
    return; // No dates to check against
  }

  const dateFrom = minDate.toLocaleDateString("sv"); // YYYY-MM-DD
  const dateToDate = new Date(maxDate);
  dateToDate.setDate(dateToDate.getDate() + lookaheadDays);
  const dateTo = dateToDate.toLocaleDateString("sv"); // YYYY-MM-DD

  const apiUrl = `${baseUrl}/gigs/query?location=${encodeURIComponent(queryLocation)}&date_from=${dateFrom}&date_to=${dateTo}`;
   Logger.log(`Querying LML API for duplicates: ${apiUrl}`);

  const options = {
    method: 'get',
    contentType: 'application/json',
    muteHttpExceptions: true // Handle errors manually
  };

  const response = UrlFetchApp.fetch(apiUrl, options);
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  if (responseCode !== 200) {
    throw new Error(`LML Query API request failed with status ${responseCode}: ${responseBody}`);
  }

  let existingGigs = [];
  try {
    existingGigs = JSON.parse(responseBody);
     Logger.log(`Received ${existingGigs.length} existing gigs from API.`);
  } catch (e) {
    throw new Error(`Failed to parse JSON response from LML Query API: ${e.message}`);
  }

  if (existingGigs.length === 0) {
     Logger.log("No existing gigs found in the specified date range.");
    return; // No duplicates possible
  }

  // --- Compare sheet rows to existing gigs ---
  const firstDataRowIndex = sheet.getRange(PropertiesService.getScriptProperties().getProperty(CONFIG.DATA_RANGE)).getRow(); // Get the actual starting row number

  sheetData.forEach((row, index) => {
    const sheetVenueId = String(row[colIndices.venueid]).trim(); // Use mapped index
    const sheetDateVal = row[colIndices.date]; // Use mapped index
    const sheetName = String(row[colIndices.name]).trim().toLowerCase(); // Use mapped index

    if (!sheetVenueId || !(sheetDateVal instanceof Date) || isNaN(sheetDateVal.getTime()) || !sheetName) {
      return; // Skip rows with missing essential data for comparison
    }
    const sheetDateStr = sheetDateVal.toLocaleDateString("sv"); // YYYY-MM-DD

    const potentialDuplicates = existingGigs.filter(existing => {
      return existing.venue &&
             String(existing.venue.id).trim() === sheetVenueId &&
             existing.date === sheetDateStr &&
             simpleSimilarityCheck(String(existing.name).trim().toLowerCase(), sheetName);
    });

    if (potentialDuplicates.length > 0) {
      const duplicateNames = potentialDuplicates.map(d => d.name).join('; ');
      const message = `Suspected Duplicate: Found existing gig(s) "${duplicateNames}" on ${sheetDateStr}`;
       Logger.log(`Row ${index + 1}: ${message}`);
      if (feedbackColIndices.status !== -1) {
        // Write status back to the correct row in the sheet
        sheet.getRange(firstDataRowIndex + index, feedbackColIndices.status + 1).setValue(message);
      }
    }
  });
}

/**
 * Basic name similarity check (case-insensitive equality).
 * TODO: Enhance this if needed (e.g., Levenshtein distance, ignore common words).
 */
function simpleSimilarityCheck(name1, name2) {
    // Simple check: ignore case and common joining words/punctuation
    const normalize = (str) => str.toLowerCase().replace(/[\W_]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Example: Check if one name contains the other after normalization
    const norm1 = normalize(name1);
    const norm2 = normalize(name2);
    return norm1.includes(norm2) || norm2.includes(norm1);
    // return name1 === name2; // Stricter check
}


/**
 * Formats the data for non-duplicate rows into a single Clipper string.
 * Uses display values primarily, but raw values for date/time objects.
 */
function formatDataAsClipper(rowsToUploadData, rowsToUploadDisplayData, headers) {
  let allClipperContent = [];
  let firstRowIndex = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PropertiesService.getScriptProperties().getProperty(CONFIG.SHEET_NAME)).getRange(PropertiesService.getScriptProperties().getProperty(CONFIG.DATA_RANGE)).getRow();

  rowsToUploadData.forEach((rowRaw, i) => {
    const rowDisplay = rowsToUploadDisplayData[i];
    const sheetRowNum = firstRowIndex + i; // Calculate actual sheet row number for error messages
    const formattedRowResult = formatRowForClipper(headers, rowDisplay, rowRaw); // Pass both raw and display

    if (formattedRowResult.error) {
      // Throw an error to be caught by the main function, including row context
      throw new Error(`Validation Error during Clipper formatting (Sheet Row ${sheetRowNum}): ${formattedRowResult.error}`);
    }
    if (formattedRowResult.clipperString) { // Only add if content was generated
      allClipperContent.push(formattedRowResult.clipperString);
    }
  });
  // Join with newline, assuming the endpoint handles multiple '---' separated blocks
  return allClipperContent.join('\n'); // Join individual gig blocks with a newline
}

/**
 * Formats a single row into the simplified Clipper style based on this-week.csv columns.
 * Returns {clipperString: string | null, error: string | null}
 */
function formatRowForClipper(headers, rowDisplay, rowRaw) {
  // Helper to get column value by name (case-insensitive) using the provided row data
  const getColumnValueInternal = (colName, headersInternal, rowData) => {
      const lowerColName = colName.toLowerCase().trim();
      // Find index using provided headers array
      const index = headersInternal.findIndex(h => String(h).toLowerCase().trim() === lowerColName);
      // Check if index is valid and row has enough elements
      // Treat blank strings as empty, return null if column not found or index out of bounds
      const value = (index !== -1 && index < rowData.length) ? rowData[index] : null;
      return (value === "" || value === null || typeof value === 'undefined') ? null : value;
  };

  const getValue = (colName) => getColumnValueInternal(colName, headers, rowDisplay);
  const getRawValue = (colName) => getColumnValueInternal(colName, headers, rowRaw);


  // --- Basic Validation ---
  const venueId = getValue('venue_id'); // Use exact header from CSV
  if (!venueId) return { clipperString: null, error: "Missing Venue ID" };
  const dateRawValue = getRawValue('date');
  if (!dateRawValue || !(dateRawValue instanceof Date) || isNaN(dateRawValue.getTime())) {
    return { clipperString: null, error: "Missing or invalid Date" };
  }
  const name = getValue('name');
  if (!name) return { clipperString: null, error: "Missing Name" };

  // --- Formatting ---
  let templateLines = [];

  // Required & Common Fields (Order based on example and CSV)
  templateLines.push(`venue_id: ${venueId}`);
  const tickets = getValue('tickets');
  if (tickets !== null) templateLines.push(`tickets: ${tickets}`); // Include even if empty string? Check requirement. Assuming yes for now.
  templateLines.push(`date: ${dateRawValue.toLocaleDateString("sv")}`); // YYYY-MM-DD

  const timeRawValue = getRawValue('time');
  let timeStr = null;
  if (timeRawValue instanceof Date && !isNaN(timeRawValue.getTime())) {
    try {
      // Format time as HH:MM:SS (matching example)
      timeStr = Utilities.formatDate(timeRawValue, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), "HH:mm:ss");
    } catch (e) {
      Logger.log(`Could not format time for row: ${e}`);
      timeStr = getValue('time'); // Fallback to display value
    }
  } else {
    timeStr = getValue('time'); // Use display value if not a valid Date
  }
  if (timeStr !== null) templateLines.push(`time: ${timeStr}`);

  templateLines.push(`name: ${name}`);

  const internalDescription = getValue('internal_description');
  if (internalDescription !== null) templateLines.push(`internal_description: ${internalDescription}`);

  // Optional Fields from CSV
  const venueName = getValue('Venue'); // Column name from CSV
  if (venueName !== null) templateLines.push(`venue: ${venueName}`);

  const status = getValue('status');
  if (status !== null) templateLines.push(`status: ${status}`);

  const information = getValue('information');
  // Handle potentially empty information field - add the line even if empty? Based on example, yes.
  templateLines.push(`information: ${information || ''}`);


  // Multiple Sets (set1 to set6)
  for (let i = 1; i <= 6; i++) {
    const setValue = getValue(`set${i}`);
    if (setValue !== null) { // Check for null explicitly
      templateLines.push(`set: ${setValue}`);
    }
  }

  // Multiple Prices (price1, price2) - Format: "price: | [value]"
  for (let i = 1; i <= 2; i++) {
    const priceValue = getValue(`price${i}`);
    if (priceValue !== null) { // Check for null explicitly
      // No description column found in CSV, so using fixed format
      templateLines.push(`price: | ${priceValue}`);
    }
  }

  // Multiple Genres (Genre Tag 1 to Genre Tag 4)
  for (let i = 1; i <= 4; i++) {
    const genreValue = getValue(`Genre Tag ${i}`); // Match CSV header casing/spacing
    if (genreValue !== null) { // Check for null explicitly
      templateLines.push(`genre: ${genreValue}`);
    }
  }

  // Add the separator
  templateLines.push('---');

  return { clipperString: templateLines.join('\n'), error: null };
}


/**
 * Fetches a CSRF token from the LML admin form page.
 */
function fetchCsrfToken(baseUrl, sessionId) {
  const formUrl = `${baseUrl}/admin/uploads/new`;
   Logger.log(`Fetching CSRF token from: ${formUrl}`);
  const options = {
    method: 'get',
    headers: {
      'Cookie': `_lml_session=${sessionId}`
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(formUrl, options);
  const responseCode = response.getResponseCode();
  const htmlContent = response.getContentText();

  if (responseCode !== 200) {
    throw new Error(`Failed to fetch CSRF token page. Status: ${responseCode}. Check LML URL and Session ID.`);
  }

  // Basic parsing for CSRF token - might need adjustment if HTML structure changes
  const match = htmlContent.match(/<input.*?name="authenticity_token".*?value="(.*?)"/);
  if (match && match[1]) {
    return match[1];
  } else {
     Logger.log(`CSRF token input field not found in HTML response from ${formUrl}`);
     Logger.log(`HTML Start: ${htmlContent.substring(0, 500)}...`); // Log start of HTML for debugging
    return null;
  }
}

/**
 * Submits the formatted data to the LML admin endpoint.
 */
function submitDataToLml(baseUrl, sessionId, csrfToken, sourceLabel, clipperContent) {
  const endpoint = `${baseUrl}/admin/uploads`;
   Logger.log(`Submitting data to: ${endpoint}`);

  const payload = {
    'authenticity_token': csrfToken,
    'lml_upload[venue_label]': '', // As per python script
    'lml_upload[venue_id]': '',   // As per python script
    'lml_upload[source]': sourceLabel,
    'lml_upload[content]': clipperContent,
    'commit': 'Create Upload'      // As per python script
  };

  const options = {
    method: 'post',
    headers: {
      'Cookie': `_lml_session=${sessionId}`,
      'Content-Type': 'application/x-www-form-urlencoded', // Matches python script
      'Referer': `${baseUrl}/admin/uploads/new`,
      'Origin': baseUrl,
      'User-Agent': 'Mozilla/5.0 (compatible; Google-Apps-Script; +https://script.google.com)' // Identify script
    },
    payload: payload,
    followRedirects: false, // Crucial!
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(endpoint, options);
  const responseCode = response.getResponseCode();
  const responseHeaders = response.getHeaders();
  const responseBody = response.getContentText();

   Logger.log(`Upload Response Code: ${responseCode}`);
   // Logger.log(`Upload Response Headers: ${JSON.stringify(responseHeaders)}`);
   // Logger.log(`Upload Response Body: ${responseBody.substring(0, 500)}...`);


  if (responseCode === 302) { // Redirect usually means success
    const location = responseHeaders['Location'];
    let uploadId = null;
    if (location) {
      // Try to extract ID, e.g., from /admin/uploads/SOME_ID
      const match = location.match(/\/admin\/uploads\/([a-f0-9-]+)/); // Assuming UUID
      if (match && match[1]) {
        uploadId = match[1];
      }
    }
    return { success: true, uploadId: uploadId, error: null };
  } else if (responseCode >= 200 && responseCode < 300) {
      // Treat 2xx as success, though 302 is more typical for Rails form submission
      return { success: true, uploadId: null, error: null };
  } else {
    // Attempt to parse error messages (basic example)
    let errorMessage = `Upload failed with status code ${responseCode}.`;
    if (responseBody) {
        // Simple check for common Rails error containers
        const errorMatch = responseBody.match(/<div.*?id="error_explanation".*?>([\s\S]*?)<\/div>/) || responseBody.match(/<div.*?class=".*?alert.*?">([\s\S]*?)<\/div>/);
        if (errorMatch && errorMatch[1]) {
            // Basic text extraction from potential error HTML
            const errorText = errorMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            errorMessage += ` Server response: ${errorText.substring(0, 200)}${errorText.length > 200 ? '...' : ''}`;
        } else {
             errorMessage += ` Body: ${responseBody.substring(0, 200)}${responseBody.length > 200 ? '...' : ''}`;
        }
    }
    return { success: false, uploadId: null, error: errorMessage };
  }
}

// Add constants for feedback status values if desired
FEEDBACK_COLS.STATUS_UPLOADED = "Uploaded";
FEEDBACK_COLS.STATUS_FAILED = "Upload Failed";
FEEDBACK_COLS.STATUS_DUPLICATE = "Suspected Duplicate"; // Base message, details added dynamically