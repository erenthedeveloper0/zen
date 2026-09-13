import { NotFound, type ZenApp } from 'zen'
import { NewOrder, Order } from './schemas.ts'
import { OrderRepoToken } from './service.ts'

export function registerOrders(app: ZenApp): void {
  app.collection('/orders', {
    name: 'orders',
    tags: ['orders'],
    meta: { description: 'Placed orders and their line items.' },
  }, (orders) => {
    orders.get('/', {
      name: 'orders.list',
      meta: { summary: 'List orders' },
      response: { 200: Order.array() },
    }, (ctx) => ctx.resolve(OrderRepoToken).list() as never)

    orders.get('/:id<int>', {
      name: 'orders.show',
      meta: { summary: 'Fetch one order' },
      response: { 200: Order },
    }, (ctx) => {
      const row = ctx.resolve(OrderRepoToken).find(ctx.params.id)
      if (row === undefined) throw new NotFound(`Order ${ctx.params.id} not found`)
      // Carries `marginCents` and `fraudScore`. Neither is declared, so neither
      // can be emitted — the generated function has no key enumeration through
      // which they could escape (§13.3).
      return row as never
    })

    orders.post('/', {
      name: 'orders.create',
      meta: { summary: 'Place an order' },
      body: NewOrder,
      response: { 201: Order },
    }, (ctx) => {
      const created = ctx.resolve(OrderRepoToken).create(ctx.body)
      ctx.res.status(201).header('location', `/orders/${created.id}`)
      return created as never
    })
  })
}
