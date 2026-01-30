import sleep from 'atomic-sleep'
import fastify from 'fastify'

interface Product {
  id: string
  name: string
  price: number
  category: string
  stock: number
  description: string
}

const app = fastify()

const debug = process.env.VERBOSE ? console.log : () => {}

const products: Product[] = (limit => {
  const products = []
  for (let i = 0; i <= limit; i++) {
    products.push({
      id: String(i),
      name: `Product ${i}`,
      price: Number((Math.random() * 1000).toFixed(2)),
      category: ['electronics', 'furniture', 'appliances'][i % 3],
      stock: Math.floor(Math.random() * 100),
      description: `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus non libero ipsum. Maecenas ultricies mauris tortor, eget bibendum enim dignissim at. Pellentesque at nisi magna. Aliquam ut purus non ante imperdiet suscipit ornare vulputate risus. Fusce sodales pretium tellus, eget pulvinar nisl semper sed. Nulla pulvinar, dui vel vestibulum pulvinar, metus tortor ornare elit, vel aliquet tortor risus at elit. Cras eget est congue, ultrices lorem id, dapibus ex. Ut quis mattis nulla, vitae bibendum neque. Duis a posuere quam, a tempor libero.
                    Ut leo velit, efficitur sagittis nisi eu, vehicula commodo arcu. Donec feugiat, neque ac pellentesque pretium, orci turpis feugiat dolor, pulvinar cursus turpis nisi nec ex. Sed tellus quam, vestibulum feugiat pharetra ut, venenatis eu augue. Nunc quis bibendum ligula. Aenean a neque lacinia, aliquet est et, sollicitudin ipsum. Cras laoreet gravida nisi eu mattis. Donec congue, ante quis accumsan feugiat, velit ligula vehicula enim, sit amet suscipit elit libero et mauris. Suspendisse euismod, orci id pellentesque molestie, lacus ante semper magna, vitae venenatis nunc nunc ac erat.
                    Mauris urna arcu, consectetur eu cursus et, euismod vitae ante. Aliquam erat volutpat. Phasellus condimentum nulla nec lorem venenatis, non convallis dolor viverra. Donec malesuada semper dolor, ut luctus nulla tempor at. Nam a ligula non purus vestibulum blandit non in mi. Aenean porttitor tristique tellus, et viverra urna luctus ac. Morbi iaculis sagittis sodales. Nunc facilisis, leo vitae interdum tincidunt, elit turpis vehicula elit, sed maximus risus dui eu ipsum. Fusce non nulla ut ante eleifend volutpat non nec lectus. Nam vel lobortis dolor.
                    Aenean mi diam, efficitur a arcu quis, placerat dictum neque. Nam dignissim convallis bibendum. Aliquam eget facilisis metus. Duis et quam leo. Donec ligula ipsum, varius sit amet justo at, rutrum euismod dolor. Nulla consectetur, mi vitae consectetur efficitur, orci diam iaculis ex, ac commodo ipsum quam nec augue. Class aptent taciti sociosqu ad litora torquent per conubia nostra, per inceptos himenaeos. Nullam neque lorem, tempor eget purus in, venenatis blandit nibh. Phasellus luctus elit at justo dictum, eget faucibus velit mattis. Nunc ex libero, malesuada non tincidunt convallis, imperdiet ac orci. Nulla auctor eros id orci consequat mollis. Cras dignissim, nisl eu blandit blandit, nibh lacus iaculis risus, vel consequat dui turpis non velit. Maecenas in vulputate orci, at commodo tellus.
                    Sed quis euismod nisl, in varius turpis. Cras hendrerit elit velit, a dictum lacus pellentesque ac. Etiam diam libero, dapibus sit amet interdum a, efficitur et turpis. Nam nec elit fringilla, tincidunt justo condimentum, elementum augue. Ut ultricies eget justo nec dictum. Sed elementum, quam malesuada interdum consequat, massa velit condimentum libero, quis vehicula lacus odio quis lorem. Nulla in turpis semper, blandit justo at, auctor nulla. Morbi mi ipsum, sagittis euismod nisl eget, consectetur luctus nisi. Donec sed ex fermentum ex tempus volutpat. Vivamus nec dolor et nisi eleifend scelerisque.`
    })
  }
  return products
})(500)

// Simulated CPU-bound activity
const simulateCpuWork = () => {
  sleep(1)
}

// Hook to add cache tags based on endpoint
app.addHook('onRequest', async (request, reply) => {
  const tags = []

  // Add endpoint-specific tags
  if (request.url.startsWith('/api/products')) {
    tags.push('products')

    const params = request.params as Record<string, string>

    if (params.id) {
      tags.push(`product:${params.id}`)
    }

    if (params.category) {
      tags.push(`category:${params.category}`)
    }
  } else if (request.url.startsWith('/api/recommendations')) {
    tags.push('recommendations')
  } else if (request.url.startsWith('/api/stats')) {
    tags.push('stats')
  }

  if (tags.length > 0) {
    reply.header('Cache-Tags', tags.join(','))
  }

  reply.header('Vary', 'x-some-header')
})

// GET all products
app.get('/api/products', async (request, reply) => {
  simulateCpuWork()

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
  const { id } = request.params as { id: number }
  simulateCpuWork()

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
  const { category } = request.params as { category: string }
  simulateCpuWork()

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
  const { userId } = request.params as { userId: string }
  simulateCpuWork()

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
  simulateCpuWork() // Expensive operation

  const stats = {
    totalProducts: Object.keys(products).length,
    totalValue: Object.values(products).reduce((sum, p: Product) => sum + p.price * p.stock, 0),
    categories: [...new Set(Object.values(products).map(p => p.category))],
    averagePrice: Object.values(products).reduce((sum, p) => sum + p.price, 0) / Object.keys(products).length,
    lowStock: Object.values(products)
      .filter(p => p.stock < 30)
      .map(p => ({ id: p.id, name: p.name, stock: p.stock }))
  }

  reply.header('Cache-Control', 'public, max-age=900') // Cache for 15 minutes
  return {
    stats,
    calculatedAt: new Date().toISOString()
  }
})

// PUT update product (invalidates cache)
app.put('/api/products/:id', async (request, reply) => {
  const { id } = request.params as { id: number }
  const updates = request.body as Partial<Product>

  simulateCpuWork()

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
  const { tags } = request.body as { tags: string[] }

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
    debug(`Starting backend server on port ${PORT}...`)
    await app.listen({ port: Number(PORT), host: '0.0.0.0' })
    debug(`Backend server listening on http://0.0.0.0:${PORT}`)
  } catch (err) {
    console.error('Backend server startup error:', err)
    process.exit(1)
  }
}

start()
