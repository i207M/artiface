// PDF.js's compatibility build still assumes APIs missing in early iPadOS 17.
// Load the missing pieces in both the viewer and its separate worker.
import 'core-js/modules/es.promise.with-resolvers.js'
import 'core-js/modules/es.array-buffer.transfer-to-fixed-length.js'
