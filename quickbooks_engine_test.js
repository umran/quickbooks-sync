const { QuickBooksEngine: QBE } = require("./quickbooks_engine")
const { quickbooks } = require("./config")

const qb = new QBE(quickbooks)

qb.resolveAccountRefs().then(res => console.log(res)).catch(err => console.error(err))