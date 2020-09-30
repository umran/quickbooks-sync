const { ApolloClient, InMemoryCache, HttpLink } = require("apollo-boost")
const fetch = require("isomorphic-unfetch")
const gql = require("graphql-tag")
const chalk = require("chalk")

class ShopifyEngine {
    constructor({ shop, admin_api_password, storefront_api_access_token }) {
        this.adminClient = createAdminClient({ uri: adminURI(shop), access_token: admin_api_password })
        this.storefrontClient = createStorefrontClient({ uri: storefrontURI(shop), access_token: storefront_api_access_token })
    }

    async getProdutVariants(cursor=null) {
        const variables = cursor ? { cursor } : null
        const res = await this.adminClient.query({ query: GET_PRODUCT_VARIANTS, variables })

        let parsed_variants = null
        let next_cursor = null
        
        if (res.data && res.data.productVariants) {
            parsed_variants = []
            for (const { node: variant } of res.data.productVariants.edges) {
                const { id, sku, barcode, selectedOptions, price, inventoryItem, taxable, product } = variant
                const { id: product_id, title, vendor, productType } = product

                let parsed_variant = {
                    id,
                    product_id,
                    title,
                    vendor,
                    product_type: productType,
                    sku,
                    barcode,
                    price,
                    selected_options: selectedOptions,
                    inventory_item: {
                        unit_cost: inventoryItem.unitCost ? {
                            amount: inventoryItem.unitCost.amount
                        } : null
                    },
                    taxable
                }

                parsed_variants = parsed_variants.concat(parsed_variant)
            }

            if (res.data.productVariants.pageInfo.hasNextPage) {
                next_cursor = res.data.productVariants.edges[res.data.productVariants.edges.length - 1].cursor
            }
        }

        return {
            items: parsed_variants,
            next_cursor
        }
    }

    async getAllProductVariants() {
        let product_variants = []

        let current_cursor = null
        let retrieving = true

        while(retrieving) {
            const { items, next_cursor } = await this.getProdutVariants(current_cursor)
            product_variants = product_variants.concat(items)
            current_cursor = next_cursor

            if (!current_cursor) {
                retrieving = false
            }
        }

        return product_variants
    }
}

const validateProductVariants = variants => {
    let existing_names = {}
    let existing_skus = {}
    let existing_barcodes = {}
    let results = []

    variants.forEach(({ id, product_id, title, vendor, sku, selected_options, barcode, price, inventory_item }) => {
        let errors = []
        
        if (!price || price == "") {
            errors = errors.concat({
                code: 100,
                message: `invalid price: price can't be empty`
            })
        }

        if (!inventory_item || !inventory_item.unit_cost || !inventory_item.unit_cost.amount || inventory_item.unit_cost.amount == "") {
            errors = errors.concat({
                code: 101,
                message: `invalid cost: cost can't be empty`
            })
        }

        if (
            (!vendor || vendor == "") ||
            (!title || title == "")
        ) {
            if (!vendor || vendor == "") {
                errors = errors.concat({
                    code: 102,
                    message: `invalid vendor: vendor can't be empty`
                })
            }
    
            if (!title || title == "") {
                errors = errors.concat({
                    code: 103,
                    message: `invalid title: title can't be empty`
                })
            }
        } else {
            const name = generateProductName({ vendor, title, selected_options })
        
            if (name.startsWith("_") || name.length > 100 ) {
                if (name.startsWith("_")) {
                    errors = errors.concat({
                        code: 104,
                        message: `invalid name: name can't start with "_"`
                    })
                }

                if (name.length > 100) {
                    errors = errors.concat({
                        code: 105,
                        message: `invalid name: name can't have more than 100 characters`
                    })
                }
            } else {
                if (existing_names[name]) {
                    errors = errors.concat({
                        code: 106,
                        message: `duplicate name: ${name}; the name is already in use by product variant with id: ${existing_names[name]}`
                    })
                } else {
                    existing_names[name] = id
                }
            }
        }

        if (!sku || sku == "") {
            errors = errors.concat({
                code: 107,
                message: `invalid sku: sku can't be empty`
            })
        } else {
            if (existing_skus[sku]) {
                errors = errors.concat({
                    code: 108,
                    message: `duplicate sku: ${sku}; the sku is already in use by product variant with id: ${existing_skus[sku]}`
                })
            } else {
                existing_skus[sku] = id
            }
        }

        if (!barcode || barcode == "") {
            errors = errors.concat({
                code: 109,
                message: `invalid barcode: barcode can't be empty`
            })
        } else {
            if (existing_barcodes[barcode]) {
                errors = errors.concat({
                    code: 110,
                    message: `duplicate barcode: ${barcode}; the barcode is already in use by product variant with id: ${existing_barcodes[barcode]}`
                })
            } else {
                existing_barcodes[barcode] = id
            }
        }

        results = results.concat({
            id,
            product_id,
            title,
            errors
        })
    })

    let ok = true
    for (const { errors } of results) {
        if (errors.length > 0) {
            ok = false
            break
        }
    }

    return {
        ok,
        results
    }
}

const logProductVariantValidationResults = ({ ok, results }) => {
    results.forEach(({ id, product_id, title, errors }) => {
        console.log(`   ${chalk.gray.bold(`[${id}]`)}`)
        console.log(`       ${chalk.gray("product id:")} ${chalk.blueBright.bold(product_id)}`)
        console.log(`       ${chalk.gray("product name:")} ${chalk.blueBright.bold(title)}`)
        if (errors.length > 0) {
            console.log(`       ${chalk.gray("status:")} ${chalk.red.bold("FAILED")}`)
            console.log(`       ${chalk.gray("errors:")}`)
            errors.forEach(({ code, message }) => {
                console.log(`           ${chalk.red.bold(code)} ${chalk.red(message)}`)
            })
        } else {
            console.log(`       ${chalk.gray("status:")} ${chalk.green.bold("PASSED")}`)
        }

        console.log("\n")
    })

    if (ok) {
        console.log(`   ${chalk.green.bold("all variants passed validation")}`)
    } else {
        console.log(`   ${chalk.red.bold("some variants did not pass validation")}`)
    }

    console.log("\n")
}

const parseProduct = variant => {
    const { title, vendor, product_type, sku, barcode, selected_options, price, inventory_item, taxable } = variant

    const name = generateProductName({ vendor, title, selected_options })
    const description = generateProductDescription({ name, barcode })
    
    const unit_price = price ? parseFloat(price) : null
    const purchase_cost = inventory_item.unit_cost ? parseFloat(inventory_item.unit_cost.amount) : null

    return {
        name,
        category: product_type,
        sku,
        description,
        unit_price,
        purchase_cost,
        taxable
    }
}

const generateProductName = ({ vendor, title, selected_options }) => {
    let name = `${vendor} ${title}`

    selected_options.forEach(({ value }) => {
        if (value && value != "Default Title") {
            name = `${name} ${value}`
        }
    })

    return name
}

const generateProductDescription = ({ name, barcode }) => {
    return `${name}, barcode: ${barcode}`
}

const createAdminClient = ({ uri, access_token }) => {
    return new ApolloClient({
        link: new HttpLink({
            uri: uri, // Server URL (must be absolute)
            // credentials: "same-origin",
            headers: {
                "X-Shopify-Access-Token": access_token
            },
            // Use fetch() polyfill on the server
            fetch: fetch
        }),
        cache: new InMemoryCache()
    })
}

const createStorefrontClient = ({ uri, access_token }) => {
    return new ApolloClient({
        link: new HttpLink({
            uri: uri, // Server URL (must be absolute)
            // credentials: "same-origin",
            headers: {
                "X-Shopify-Storefront-Access-Token": access_token
            },
            // Use fetch() polyfill on the server
            fetch: fetch
        }),
        cache: new InMemoryCache()
    })
}

const GET_PRODUCT_VARIANTS = gql`
    query getProductVariants($cursor: String) {
        productVariants(first: 100, after: $cursor) {
            pageInfo {
                hasNextPage
            }
            edges {
                cursor
                node {
                    id
                    sku
                    barcode
                    product {
                        id
                        title
                        vendor
                        productType
                    }
                    selectedOptions {
                        value
                    }
                    price
                    inventoryItem {
                        unitCost {
                            currencyCode
                            amount
                        }
                    }
                    taxable
                }
            }
        }
    }
`

const storefrontURI = (shop) => {
    return `https://${shop}.myshopify.com/api/2019-07/graphql.json`
}

const adminURI = (shop) => {
    return `https://${shop}.myshopify.com/admin/api/2020-07/graphql.json`
}

module.exports = {
    ShopifyEngine,
    validateProductVariants,
    logProductVariantValidationResults,
    parseProduct,
}