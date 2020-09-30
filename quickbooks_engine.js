const QuickBooks = require("node-quickbooks")

class QuickBooksEngine {
    constructor({ client_id, client_secret, access_token, realm_id, refresh_token, sandbox = true, debug = true }) {
        this.client = new QuickBooks(
            client_id,
            client_secret,
            access_token,
            false, // no token secret for oAuth 2.0
            realm_id,
            sandbox, // use the sandbox?
            debug, // enable debugging?
            null, // set minorversion, or null for the latest version
            '2.0', //oAuth version
            refresh_token
        )
        this.accounts = {}
    }

    refreshAccessToken() {
        return new Promise((resolve, reject) => {
            this.client.refreshAccessToken((err, res) => {
                if (err) {
                    reject(err)
                    return
                }

                if (!res.access_token || !res.refresh_token) {
                    reject(new Error("missing auth data"))
                }

                resolve()
            })
        })
    }

    createCategory(name) {
        return new Promise((resolve, reject) => {
            this.client.createItem({
                Name: name,
                Type: "Category"
            }, (err, item) => {
                if (err) {
                    reject(err)
                    return
                }

                resolve(item)
            })
        })
    }

    createProduct(product) {
        return new Promise((resolve, reject) => {
            this.client.createItem({
                ...product,
                Type: "Inventory"
            }, (err, item) => {
                if (err) {
                    reject(err)
                    return
                }

                resolve(item)
            })
        })
    }

    updateProduct(product) {
        return new Promise((resolve, reject) => {
            this.client.updateItem(product, (err, item) => {
                if (err) {
                    reject(err)
                    return
                }

                resolve(item)
            })
        })
    }

    findAccountByName(name) {
        return new Promise((resolve, reject) => {
            this.client.findAccounts({
                Name: name
            }, (err, res) => {
                if (err) {
                    reject(err)
                    return
                } 
                
                resolve(res.QueryResponse && res.QueryResponse.Account && res.QueryResponse.Account.length > 0 ? res.QueryResponse.Account[0] : null)
            })
        })
    }

    findCategoryByName(name) {
        return new Promise((resolve, reject) => {
            this.client.findItems({
                Name: name,
                Type: "Category"
            }, (err, res) => {
                if (err) {
                    reject(err)
                    return
                }

                resolve(res.QueryResponse && res.QueryResponse.Item && res.QueryResponse.Item.length > 0 ? res.QueryResponse.Item[0] : null)
            })
        })
    }

    findProductBySKU(sku) {
        return new Promise((resolve, reject) => {
            this.client.findItems({
                Sku: sku,
                Type: "Inventory"
            }, (err, res) => {
                if (err) {
                    reject(err)
                    return
                }

                resolve(res.QueryResponse && res.QueryResponse.Item && res.QueryResponse.Item.length > 0 ? res.QueryResponse.Item[0] : null)
            })
        })
    }

    findProductByName(name) {
        return new Promise((resolve, reject) => {
            this.client.findItems({
                Name: name,
                Type: "Inventory"
            }, (err, res) => {
                if (err) {
                    reject(err)
                    return
                }

                resolve(res.QueryResponse && res.QueryResponse.Item && res.QueryResponse.Item.length > 0 ? res.QueryResponse.Item[0] : null)
            })
        })
    }

    async findOrCreateCategoryByName(name) {
        let category = await this.findCategoryByName(name)
        if (!category) {
            category = await this.createCategory(name)
        }

        return category
    }

    async resolveAccountRefs() {
        const results = await Promise.all([this.findAccountByName("Sales of Product Income"), this.findAccountByName("Cost of Goods Sold"), this.findAccountByName("Inventory Asset")])
        const refs = results.reduce((accounts, r) => {
            if (r.Name == "Sales of Product Income") {
                accounts = {
                    ...accounts,
                    income_account_ref: { value: r.Id, name: r.Name }
                }
            }

            if (r.Name == "Cost of Goods Sold") {
                accounts = {
                    ...accounts,
                    expense_account_ref: { value: r.Id, name: r.Name }
                }
            }

            if (r.Name == "Inventory Asset") {
                accounts = {
                    ...accounts,
                    asset_account_ref: { value: r.Id, name: r.Name }
                }
            }

            return accounts
        }, {})

        return refs
    }

    async syncProduct(product) {
        const latest_category = product.category ? await this.findOrCreateCategoryByName(product.category) : null
        
        const latest_product = {
            Name: product.name,
            Sku: product.sku,
            Description: product.description,
            PurchaseDesc: product.description,
            UnitPrice: product.unit_price,
            PurchaseCost: product.purchase_cost,
            Taxable: product.taxable,
            SubItem: latest_category ? true : false,
            ParentRef: latest_category ? { value: latest_category.value, name: latest_category.name } : null
        }

        let existing_product

        // temporarily inactivate and yield the name from any product that has the same name but not the same sku
        // as we don't want product creation to fail due to a duplicate name
        let same_name_product = await this.findProductByName(latest_product.Name)
        
        if (same_name_product) {
            if (same_name_product.Sku == latest_product.Sku) {
                existing_product = same_name_product
            } else {
                // time to inactivate and yield the name from same_name_product
                await this.updateProduct({
                    ...same_name_product,
                    Name: `_${same_name_product.Sku}`,
                    Active: false,
                    sparse: false
                })
            }
        }

        if (!existing_product) {
            // determine if a product by the same sku exists
            existing_product = await this.findProductBySKU(latest_product.Sku)
        }

        if (existing_product) {
            if (didChangeProductContent(existing_product, latest_product) || !existing_product.Active) {
                // update product
                await this.updateProduct({
                    ...existing_product,
                    ...latest_product,
                    Active: true,
                    sparse: false
                })
            }
            
            return
        }

        // create product
        const accounts = await this.resolveAccountRefs()
        await this.createProduct({
            ...latest_product,
            Active: true,
            TrackQtyOnHand: true,
            QtyOnHand: 0,
            InvStartDate: new Date().toISOString().slice(0, 10),
            IncomeAccountRef: accounts.income_account_ref,
            ExpenseAccountRef: accounts.expense_account_ref,
            AssetAccountRef: accounts.asset_account_ref
        })
    }
}

const didChangeProductContent = (existing_product, latest_product) => {
    return !(
        ((!existing_product.ParentRef && !latest_product.ParentRef) || (existing_product.ParentRef && latest_product.ParentRef && existing_product.ParentRef.value == latest_product.ParentRef.value)) &&
        existing_product.Name == latest_product.Name &&
        existing_product.Sku == latest_product.Sku &&
        existing_product.Description == latest_product.Description &&
        existing_product.UnitPrice == latest_product.UnitPrice &&
        existing_product.PurchaseCost == latest_product.PurchaseCost
    )
}

module.exports = {
    QuickBooksEngine
}