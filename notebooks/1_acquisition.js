var YEAR  = 2021;
var BANDS = ['B2','B3','B4','B5','B6','B7','B8','B8A','B11','B12'];

var zones = [
  // Arkansas — zones agrandies (~1.5° × 1.0°)
  { name: 'Arkansas_Zone1',
    geometry: ee.Geometry.Rectangle([-91.60, 33.50, -89.80, 36.50]),
    state: 'arkansas' },
  { name: 'Arkansas_Zone2',
    geometry: ee.Geometry.Rectangle([-95.00, 34.00, -91.60, 36.50]),
    state: 'arkansas' },

  // California — zones agrandies (~2.0° × 1.2°)
  { name: 'California_Zone1',
    geometry: ee.Geometry.Rectangle([-122.50, 38.00, -120.50, 40.50]),
    state: 'california' },
  { name: 'California_Zone2',
    geometry: ee.Geometry.Rectangle([-121.00, 35.00, -118.50, 38.00]),
    state: 'california' }
];


var arkansas_from   = [1, 2, 3, 5];
var arkansas_to     = [1, 2, 3, 5];
var california_from = [69, 3, 36, 75, 204];
var california_to   = [1,  2,  3,  4,  5];

// Masque nuages
function maskClouds(image) {
  var scl = image.select('SCL');
  var cloudMask = scl.eq(3).or(scl.eq(8)).or(scl.eq(9)).or(scl.eq(10));
  return image.updateMask(cloudMask.not())
              .select(BANDS)
              .divide(10000)
              .copyProperties(image, ['system:time_start']);
}

// 36 composites de 10 jours
function makeComposites(s2) {
  var emptyImage = ee.Image.constant(ee.List.repeat(0, BANDS.length)).rename(BANDS);
  var fallbackCollection = ee.ImageCollection([emptyImage]);

  return ee.List.sequence(0, 35).map(function(step) {
    step = ee.Number(step);
    var start    = ee.Date(YEAR + '-01-01').advance(step.multiply(10), 'day');
    var end      = start.advance(10, 'day');
    var stepStr  = step.int().format('%02d');
    var newNames = ee.List(BANDS).map(function(b) {
      return ee.String(b).cat('_t').cat(stepStr);
    });
    var filtered = s2.filterDate(start, end);
    var img      = filtered.merge(fallbackCollection).median().unmask(0);
    return img.rename(newNames);
  });
}

// Stack toutes les bandes
function stackComposites(compositeList) {
  var first = ee.Image(compositeList.get(0));
  var rest  = compositeList.slice(1);
  return ee.Image(
    rest.iterate(function(img, acc) {
      return ee.Image(acc).addBands(ee.Image(img));
    }, first)
  );
}

// Pipeline par zone
function processZone(zone) {
  var geometry = zone.geometry;
  var name     = zone.name;
  var state    = zone.state;

  var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterDate(YEAR + '-01-01', YEAR + '-12-31')
    .filterBounds(geometry)
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 90))
    .map(maskClouds);

  var cdl          = ee.Image('USDA/NASS/CDL/2021').select('cropland').clip(geometry);
  var conf         = ee.Image('USDA/NASS/CDL/2021').select('confidence').clip(geometry);
  var cdl_filtered = cdl.updateMask(conf.gte(95));
  var worldcover   = ee.ImageCollection('ESA/WorldCover/v200').first().clip(geometry);
  var cdl_masked = cdl_filtered;

  var cdl_reclass;
  if (state === 'arkansas') {
    cdl_reclass = cdl_masked.remap(arkansas_from, arkansas_to, 99).rename('label');
  } else {
    cdl_reclass = cdl_masked.remap(california_from, california_to, 99).rename('label');
  }

  var samples = cdl_reclass.sample({
    numPixels:  50000,
    region:     geometry,
    scale:      20,
    seed:       42,
    geometries: true
  });

  // Export labels + coordonnées
  Export.table.toDrive({
    collection:     samples,
    description:    'MCTNet_' + name + '_labels',
    folder:         'MCTNet_Data',
    fileNamePrefix: 'MCTNet_' + name + '_labels',
    fileFormat:     'CSV'
  });

  // Export 1 composite à la fois (10 bandes par export)
  var emptyImage   = ee.Image.constant(ee.List.repeat(0, BANDS.length)).rename(BANDS);
  var fallbackColl = ee.ImageCollection([emptyImage]);

  for (var step = 1; step <= 36; step++) {
    var stepStr  = (step < 10) ? '0' + step : '' + step;
    var start    = ee.Date(YEAR + '-01-01').advance(step * 10, 'day');
    var end      = start.advance(10, 'day');
    var newNames = BANDS.map(function(b) { return b + '_t' + stepStr; });
    var filtered = s2.filterDate(start, end);
    var img      = filtered.merge(fallbackColl).median().unmask(0).rename(newNames);

    var training = img.sampleRegions({
      collection: samples,
      properties: ['label'],
      scale:      20,
      tileScale:  16,
      geometries: false
    });

    Export.table.toDrive({
      collection:     training,
      description:    'MCTNet_' + name + '_t' + stepStr,
      folder:         'MCTNet_Data',
      fileNamePrefix: 'MCTNet_' + name + '_t' + stepStr,
      fileFormat:     'CSV'
    });
  }

  print('Zone ' + name + ' : 37 exports crees (1 label + 36 composites)');
}

// Lancer les 4 zones
for (var i = 0; i < zones.length; i++) {
  processZone(zones[i]);
}

print('');
print('Aller dans Tasks et cliquer Run sur chaque export');

// Visualisation
Map.setCenter(-95, 37, 5);
var colors = ['red', 'blue', 'green', 'orange'];
for (var j = 0; j < zones.length; j++) {
  Map.addLayer(
    ee.Image().paint(
      ee.FeatureCollection([ee.Feature(zones[j].geometry)]), 1, 2
    ),
    {palette: [colors[j]]},
    zones[j].name
  );
}