const { QuickBooksEngine: QBE } = require("./quickbooks_engine")
const { quickbooks } = require("./config")

const qb = new QBE(quickbooks)

qb.findProductBySKU("PRTO12").then(product => qb.updateProduct({
    ...product,
    Name: "Chorizo",
    sparse: false
})).then(updated => console.log(updated)).catch(err => console.error(JSON.stringify(err)))