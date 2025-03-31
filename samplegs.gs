
// Dummy handler for "Settings..."
function openSettings() {
  SpreadsheetApp.getUi().alert('Settings dialog would open here.');
}

// Dummy handler for "Generate exports"
function generateExports() {
  exportRowsToClipper(getExportSpreadsheet())
}





function getSheets(){
  sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  
  return sheets.map(x=>[x.getSheetId(),x.getSheetName()]).filter(x=>x[1].toLowerCase().indexOf("gig")>-1)
}

function saveClipperConfig(sheetName){
  spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  sheetName = sheetName || "Gig data entry - This week";
  ss.addDeveloperMetadata('NAME')

// Gets the first developer metadata object and logs its key.
  const developerMetaData = ss.getDeveloperMetadata()[0]
  console.log(developerMetaData.getKey())
  Browser.msgBox("Selected sheet: " + sheetName);
  sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  Browser.msgBox("Going to do something with : " + sheet.getSheetName())
  
  exportRowsToClipper(sheet)
}

function exportRowsToClipper(sheet) {
  const data = sheet.getDataRange().getDisplayValues();
  const rawData = sheet.getDataRange().getValues();
  ensureHeaderExists(sheet,"Exportable");
  ensureHeaderExists(sheet,"Export errors");
  let headers = data[0].map(header => header.toLowerCase().trim());
  const rows = data.slice(1); // Exclude headers
  const rowsRaw = rawData.slice(1); // Exclude headers
  // Generate template output for each row, ignoring the 'Exportable' column
  const exportableHeaders = headers.filter(header => header !== 'exportable' && header !== 'export errors')
  const exportableValues= rows.map((row,i) => 
    formatRow(exportableHeaders,row,rowsRaw[i]));
  const exportableColIndex = headers.indexOf("exportable");

  // Write the generated templates to the 'Exportable' column - assume errors is next to it! 
  const range = sheet.getRange(2, exportableColIndex + 1, rows.length, 2);
  //range.setValues(exportableValues.map(r=>r[0])); // Write values back to the sheet
    range.setValues(exportableValues); // Write values back to the sheet
}

function formatRow(headers,row,rowsRaw) {
  const tickets = getColumnValue('tickets', headers, row);
  const dateRaw = getColumnValue('date', headers,rowsRaw);
  if(!dateRaw || dateRaw == ""){
    return ["",""]
  }

  const errors = validateRowForExport(headers,rowsRaw);
  if(errors){
    return ["",errors.join("\n")]
  }
  const venueId = getColumnValue('venue_id', headers, row);
  
  // sweden gets it right :/ should include timezone now (it does not matter but I just wanted iso style dates and times)
  const date = dateRaw.toLocaleDateString("sv");
  const timeRaw = getColumnValue('time', headers, rowsRaw);
  const time = timeRaw ? timeRaw.toLocaleTimeString("sv") : "";
  const name = getColumnValue('name', headers, row);
  const internalDescription = getColumnValue('internal_description', headers, row);

  // Construct the multiline template
  let template = `
venue_id: ${venueId}
tickets: ${tickets}
date: ${date}
time: ${time}
name: ${name}
internal_description: ${internalDescription}
`;

  // Append other columns dynamically, removing trailing numbers from headers
  headers.forEach((header, index) => {
    if (!['venue_id', 'tickets', 'date', 'time', 'name', 'internal_description','status','clipper output (unused)'].includes(header)) {
      const value = row[index] ? row[index].toString().trim() : '';
      if (value) {
        const normalizedHeader = header.replace(/\d+$/, '') // Remove trailing numbers
                                       .replace(/genre tag\s?/, 'genre'); // fix genre tag field
        template += `${normalizedHeader}: ${value}\n`;
      }
    }
  });

  template += '---';
  return [template.trim(),""];
}

// Helper to get column value by name
function getColumnValue(columnName, headers, row) {
  const index = headers.indexOf(columnName);
  return index >= 0 ? row[index] : '';
}

function ensureHeaderExists(sheet, headerName) {
  const data = sheet.getDataRange().getValues();
  let headers = data[0].map(header => header.toLowerCase().trim());
  
  let headerIndex = headers.indexOf(headerName.toLowerCase().trim());

  if (headerIndex === -1) {
    headerIndex = headers.length;
    sheet.getRange(1, headerIndex + 1).setValue(headerName); // Add new header
  }

  return headerIndex;
}




/**
 * Creates a custom menu in the spreadsheet UI when the spreadsheet is opened.
 * @param {Object} e The event parameter for a simple trigger.
 */
function onOpen(e) {
  SpreadsheetApp.getUi()
      .createMenu('LML Tools') // You can change the menu name if needed
      .addItem('Generate Exports (Old)', 'generateExports') // Calls existing function
      .addSeparator()
      .addItem('Upload Gigs with Check', 'uploadGigsWithCheck') // Calls the new function from UploadLogic.gs
      .addToUi();
}
