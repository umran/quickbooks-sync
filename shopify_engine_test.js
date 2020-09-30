const { ShopifyEngine: SE, validateProductVariants, parseProduct, logProductVariantValidationResults } = require("./shopify_engine")
const { shopify } = require("./config")

const se = new SE(shopify)

se.getAllProductVariants().then(variants => {
    logProductVariantValidationResults(validateProductVariants(variants))
}).catch(err => console.error(err))
