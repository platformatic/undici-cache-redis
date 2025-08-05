'use strict'

const fastify = require('fastify')
const sleep = require('atomic-sleep')

const app = fastify()

// Simulated database of products
const products = {
  1: { id: '1', name: 'Laptop Pro', price: 1299.99, category: 'electronics', stock: 50 },
  2: { id: '2', name: 'Wireless Mouse', price: 29.99, category: 'electronics', stock: 200 },
  3: { id: '3', name: 'Office Chair', price: 399.99, category: 'furniture', stock: 25 },
  4: { id: '4', name: 'Standing Desk', price: 599.99, category: 'furniture', stock: 15 },
  5: { id: '5', name: 'Coffee Maker', price: 89.99, category: 'appliances', stock: 100 }
}

// Simulated CPU-bound activity
const simulateCpuWork = (min = 10, max = 30) => {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min
  sleep(delay)
}

// Hook to add cache tags based on endpoint
app.addHook('onRequest', async (request, reply) => {
  const tags = []

  // Add endpoint-specific tags
  if (request.url.startsWith('/api/products')) {
    tags.push('products')

    if (request.params.id) {
      tags.push(`product:${request.params.id}`)
    }

    if (request.params.category) {
      tags.push(`category:${request.params.category}`)
    }
  } else if (request.url.startsWith('/api/recommendations')) {
    tags.push('recommendations')
  } else if (request.url.startsWith('/api/stats')) {
    tags.push('stats')
  }

  if (tags.length > 0) {
    reply.header('Cache-Tags', tags.join(','))
  }
})

// GET all products
app.get('/api/products', async (request, reply) => {
  simulateCpuWork(200, 600)

  const productList = Object.values(products)
  reply.header('Cache-Control', 'public, max-age=300') // Cache for 5 minutes
  return {
    products: productList,
    total: productList.length,
    timestamp: new Date().toISOString()
  }
})

// GET product by ID
app.get('/api/products/:id', async (request, reply) => {
  const { id } = request.params
  simulateCpuWork(100, 300)

  const product = products[id]
  if (!product) {
    reply.code(404)
    return { error: 'Product not found' }
  }

  reply.header('Cache-Control', 'public, max-age=600') // Cache for 10 minutes
  return {
    product,
    timestamp: new Date().toISOString()
  }
})

// GET products by category
app.get('/api/products/category/:category', async (request, reply) => {
  const { category } = request.params
  simulateCpuWork(150, 400)

  const categoryProducts = Object.values(products).filter(p => p.category === category)

  reply.header('Cache-Control', 'public, max-age=300') // Cache for 5 minutes
  return {
    category,
    products: categoryProducts,
    total: categoryProducts.length,
    timestamp: new Date().toISOString()
  }
})

// GET personalized recommendations (changes frequently)
app.get('/api/recommendations/:userId', async (request, reply) => {
  const { userId } = request.params
  simulateCpuWork(300, 800)

  // Simulate personalized recommendations
  const allProducts = Object.values(products)
  const recommendations = []
  const used = new Set()

  while (recommendations.length < 3) {
    const index = Math.floor(Math.random() * allProducts.length)
    if (!used.has(index)) {
      used.add(index)
      recommendations.push(allProducts[index])
    }
  }

  reply.header('Cache-Control', 'public, max-age=60') // Cache for 1 minute
  return {
    userId,
    recommendations,
    generatedAt: new Date().toISOString()
  }
})

// GET statistics (expensive operation)
app.get('/api/stats', async (request, reply) => {
  simulateCpuWork(500, 1000) // Expensive operation

  const stats = {
    totalProducts: Object.keys(products).length,
    totalValue: Object.values(products).reduce((sum, p) => sum + (p.price * p.stock), 0),
    categories: [...new Set(Object.values(products).map(p => p.category))],
    averagePrice: Object.values(products).reduce((sum, p) => sum + p.price, 0) / Object.keys(products).length,
    lowStock: Object.values(products).filter(p => p.stock < 30).map(p => ({ id: p.id, name: p.name, stock: p.stock }))
  }

  reply.header('Cache-Control', 'public, max-age=900') // Cache for 15 minutes
  return {
    stats,
    calculatedAt: new Date().toISOString()
  }
})

// PUT update product (invalidates cache)
app.put('/api/products/:id', async (request, reply) => {
  const { id } = request.params
  const updates = request.body

  simulateCpuWork(100, 200)

  if (!products[id]) {
    reply.code(404)
    return { error: 'Product not found' }
  }

  // Update product
  products[id] = { ...products[id], ...updates }

  // Return updated product with cache invalidation hint
  reply.header('X-Cache-Invalidate', `product:${id},products`)
  return {
    product: products[id],
    updated: true,
    timestamp: new Date().toISOString()
  }
})

// POST invalidate cache by tags (admin endpoint)
app.post('/api/admin/invalidate-cache', async (request, reply) => {
  const { tags } = request.body

  return {
    message: 'Cache invalidation request received',
    tags,
    timestamp: new Date().toISOString()
  }
})

// Health check
app.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

const PORT = process.env.PORT || 3000

const start = async () => {
  try {
    console.log(`Starting backend server on port ${PORT}...`)
    await app.listen({ port: PORT, host: '0.0.0.0' })
    console.log(`Backend server listening on http://0.0.0.0:${PORT}`)
  } catch (err) {
    console.error('Backend server startup error:', err)
    process.exit(1)
  }
}

start()
