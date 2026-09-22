import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

interface Product {
  id: number
  name: string
  price: number
  weight: number // lbs
  emoji: string
  description: string
  category: string
}

interface CartItem {
  product: Product
  qty: number
}

interface Order {
  items: CartItem[]
  total: number
  weight: number
  orderedAt: Date
  eta: Date
  address: string
}

type Page = 'shop' | 'tracking' | 'account'
type DeliveryStatus = 'idle' | 'in-flight' | 'arrived' | 'confirmed'

interface DelayWindow {
  start: number // progress fraction [0,1]
  end: number
}

interface DelaySchedule {
  lowBattery: DelayWindow | null
  weather: DelayWindow | null
}

function randomDelaySchedule(): DelaySchedule {
  const window = (lo: number, hi: number, dur: number): DelayWindow => {
    const start = lo + Math.random() * (hi - lo)
    return { start, end: Math.min(start + dur, 0.95) }
  }
  return {
    lowBattery: Math.random() < 0.5 ? window(0.55, 0.75, 0.12) : null,
    weather:    Math.random() < 0.5 ? window(0.15, 0.45, 0.15) : null,
  }
}

function isWeatherActive(w: DelayWindow | null, progress: number): boolean {
  return w !== null && progress >= w.start && progress <= w.end
}

function isBatteryActive(w: DelayWindow | null, progress: number): boolean {
  return w !== null && progress >= w.start // sticky: stays once triggered
}

/** Total real seconds for delivery given a weather slowdown window (0.5× speed during weather). */
function totalDeliverySeconds(weather: DelayWindow | null): number {
  if (!weather) return DELIVERY_SECONDS
  const dur = weather.end - weather.start
  return DELIVERY_SECONDS * (1 + dur) // extra dur*D seconds for the slow segment
}

/**
 * Compute drone progress [0,1] from real elapsed seconds, accounting for
 * weather slowing the drone to 0.5× speed within its window.
 */
function progressFromElapsed(elapsed: number, weather: DelayWindow | null): number {
  const D = DELIVERY_SECONDS
  if (!weather) return Math.min(elapsed / D, 1)

  const p1 = weather.start
  const p2 = weather.end
  const t_before = p1 * D           // real seconds to reach start of weather
  const t_weather = (p2 - p1) * D * 2 // real seconds to cross weather at 0.5× speed

  if (elapsed <= t_before) {
    return elapsed / D
  } else if (elapsed <= t_before + t_weather) {
    return p1 + (elapsed - t_before) / (D * 2)
  } else {
    return Math.min(p2 + (elapsed - t_before - t_weather) / D, 1)
  }
}

// ── Product Catalog ──────────────────────────────────────────────────────────

const PRODUCTS: Product[] = [
  { id: 1, name: 'Organic Apples', price: 3.49, weight: 1.0, emoji: '🍎', description: 'Crisp Fuji apples, 1 lb bag. Locally sourced from regional orchards.', category: 'Produce' },
  { id: 2, name: 'Sourdough Bread', price: 5.99, weight: 0.9, emoji: '🍞', description: 'Artisan sourdough with a perfectly crunchy crust, baked fresh daily.', category: 'Bakery' },
  { id: 3, name: 'Greek Yogurt', price: 2.79, weight: 1.0, emoji: '🥛', description: 'Thick, creamy plain Greek yogurt. High protein, no added sugar.', category: 'Dairy' },
  { id: 4, name: 'Sharp Cheddar', price: 3.99, weight: 0.5, emoji: '🧀', description: '2-year aged sharp cheddar, sliced. Rich, complex flavor.', category: 'Dairy' },
  { id: 5, name: 'Penne Pasta', price: 1.99, weight: 1.0, emoji: '🍝', description: 'Premium durum wheat penne, 16 oz box. Perfect al dente texture.', category: 'Pantry' },
  { id: 6, name: 'Tomato Sauce', price: 2.49, weight: 1.1, emoji: '🍅', description: 'San Marzano crushed tomatoes with basil, 14.5 oz can.', category: 'Pantry' },
  { id: 7, name: 'Granola Bars', price: 4.99, weight: 0.44, emoji: '🌾', description: 'Oat & honey granola bars, 6-pack. Perfect for on-the-go snacking.', category: 'Snacks' },
  { id: 8, name: 'Baby Spinach', price: 3.29, weight: 0.31, emoji: '🥬', description: 'Pre-washed organic baby spinach, 5 oz clamshell. Triple washed.', category: 'Produce' },
  { id: 9, name: 'Almond Butter', price: 6.49, weight: 1.0, emoji: '🥜', description: 'Smooth roasted almond butter, 16 oz jar. No added oil or sugar.', category: 'Pantry' },
  { id: 10, name: 'Orange Juice', price: 4.29, weight: 2.0, emoji: '🍊', description: '100% fresh-squeezed orange juice, 32 fl oz. No pulp.', category: 'Beverages' },
  { id: 11, name: 'Eggs (6-pack)', price: 3.79, weight: 0.75, emoji: '🥚', description: 'Free-range large eggs, half dozen. Grade A, white shell.', category: 'Dairy' },
  { id: 12, name: 'Avocado', price: 1.49, weight: 0.37, emoji: '🥑', description: 'Ripe Hass avocado, ready to eat. Rich buttery flavor.', category: 'Produce' },
]

const MAX_WEIGHT = 5.0

// ── Map constants ────────────────────────────────────────────────────────────

const MAP_W = 520
const MAP_H = 320
const WAREHOUSE = { x: 60, y: 260 }
const DESTINATION = { x: 430, y: 80 }
const DELIVERY_SECONDS = 15 // 15 real seconds = 15 simulated minutes

// No-fly zone bounds — aligned to the block cell between streets x=160–250, y=130–200
const NFZ = { x: 169, y: 139, w: 72, h: 52 }

// street grid for the fake map (strokeWidth=18, so each street center±9 is road)
const STREETS_H = [60, 130, 200, 270]
const STREETS_V = [80, 160, 250, 360, 440]

// Drone flight path: waypoints that route around the no-fly zone (below + right)
const PATH_WAYPOINTS = [
  { x: 60,  y: 260 }, // warehouse
  { x: 155, y: 235 }, // approach, start diverting south of zone
  { x: 260, y: 215 }, // clear the zone to the right (zone ends at x=240, y=190)
  { x: 370, y: 130 }, // climbing toward destination
  { x: 430, y: 80  }, // destination
]

// Precompute cumulative arc lengths for uniform-speed interpolation
const SEG_LENGTHS: number[] = []
for (let i = 1; i < PATH_WAYPOINTS.length; i++) {
  const dx = PATH_WAYPOINTS[i].x - PATH_WAYPOINTS[i - 1].x
  const dy = PATH_WAYPOINTS[i].y - PATH_WAYPOINTS[i - 1].y
  SEG_LENGTHS.push(Math.sqrt(dx * dx + dy * dy))
}
const TOTAL_LENGTH = SEG_LENGTHS.reduce((s, l) => s + l, 0)

// The drone has cleared the no-fly zone once it reaches waypoint index 2 (x=260,y=215)
const NFZ_CLEAR_PROGRESS = (SEG_LENGTHS[0] + SEG_LENGTHS[1]) / TOTAL_LENGTH

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(n: number) { return `$${n.toFixed(2)}` }
function fmtWeight(n: number) { return `${n.toFixed(2)} lb` }

function lerp(a: number, b: number, t: number) { return a + (b - a) * t }

/** Returns {x, y} for a drone progress value [0,1] along PATH_WAYPOINTS */
function dronePosition(progress: number): { x: number; y: number } {
  const target = progress * TOTAL_LENGTH
  let walked = 0
  for (let i = 0; i < SEG_LENGTHS.length; i++) {
    const segLen = SEG_LENGTHS[i]
    if (walked + segLen >= target || i === SEG_LENGTHS.length - 1) {
      const t = segLen === 0 ? 0 : (target - walked) / segLen
      return {
        x: lerp(PATH_WAYPOINTS[i].x, PATH_WAYPOINTS[i + 1].x, t),
        y: lerp(PATH_WAYPOINTS[i].y, PATH_WAYPOINTS[i + 1].y, t),
      }
    }
    walked += segLen
  }
  return PATH_WAYPOINTS[PATH_WAYPOINTS.length - 1]
}

/** SVG polyline points string for the full planned flight path */
const FULL_PATH_POINTS = PATH_WAYPOINTS.map(p => `${p.x},${p.y}`).join(' ')

/** SVG polyline points string for the portion of the path already flown */
function flownPathPoints(progress: number): string {
  const target = progress * TOTAL_LENGTH
  const pts: string[] = [`${PATH_WAYPOINTS[0].x},${PATH_WAYPOINTS[0].y}`]
  let walked = 0
  for (let i = 0; i < SEG_LENGTHS.length; i++) {
    const segLen = SEG_LENGTHS[i]
    if (walked + segLen >= target) {
      const t = segLen === 0 ? 0 : (target - walked) / segLen
      const x = lerp(PATH_WAYPOINTS[i].x, PATH_WAYPOINTS[i + 1].x, t)
      const y = lerp(PATH_WAYPOINTS[i].y, PATH_WAYPOINTS[i + 1].y, t)
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
      break
    }
    walked += segLen
    pts.push(`${PATH_WAYPOINTS[i + 1].x},${PATH_WAYPOINTS[i + 1].y}`)
  }
  return pts.join(' ')
}

// ── Components ───────────────────────────────────────────────────────────────

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium" style={{ background: color + '22', color }}>
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

function WeightBar({ current, max }: { current: number; max: number }) {
  const pct = Math.min(current / max, 1)
  const color = pct > 0.9 ? '#ef4444' : pct > 0.7 ? '#eab308' : '#22c55e'
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs mb-1" style={{ color: '#64748b' }}>
        <span>Weight</span>
        <span style={{ color: pct > 0.9 ? '#ef4444' : '#0f172a' }}>{fmtWeight(current)} / {fmtWeight(max)}</span>
      </div>
      <div className="h-2 rounded-full" style={{ background: '#e2e8f0' }}>
        <div className="h-2 rounded-full transition-all duration-300" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  )
}

// ── Product Card ─────────────────────────────────────────────────────────────

function ProductCard({ product, onSelect }: { product: Product; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="text-left rounded-xl p-4 transition-all duration-150 hover:scale-[1.02] hover:shadow-lg focus:outline-none focus:ring-2"
      style={{ background: '#fff', border: '1px solid #e2e8f0' }}
    >
      <div className="flex items-center justify-center h-16 text-4xl mb-3 rounded-lg" style={{ background: '#f5f7fa' }}>
        {product.emoji}
      </div>
      <div className="font-semibold text-sm leading-tight mb-1" style={{ color: '#0f172a' }}>{product.name}</div>
      <div className="text-xs mb-2" style={{ color: '#64748b' }}>{product.category}</div>
      <div className="flex items-center justify-between">
        <span className="font-bold text-sm" style={{ color: '#4a90e2' }}>{fmtPrice(product.price)}</span>
        <span className="text-xs" style={{ color: '#94a3b8' }}>{fmtWeight(product.weight)}</span>
      </div>
    </button>
  )
}

// ── Product Detail Modal ─────────────────────────────────────────────────────

function ProductModal({
  product, cartWeight, onClose, onAddToCart
}: {
  product: Product
  cartWeight: number
  onClose: () => void
  onAddToCart: (product: Product, qty: number) => void
}) {
  const [qty, setQty] = useState(1)
  const wouldExceed = cartWeight + product.weight * qty > MAX_WEIGHT
  const maxQty = Math.max(1, Math.floor((MAX_WEIGHT - cartWeight) / product.weight))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,29,58,0.7)' }}>
      <div className="rounded-2xl shadow-2xl w-full max-w-sm mx-4" style={{ background: '#fff' }}>
        <div className="flex items-center justify-center h-40 text-6xl rounded-t-2xl" style={{ background: '#f5f7fa' }}>
          {product.emoji}
        </div>
        <div className="p-6">
          <div className="flex items-start justify-between mb-1">
            <h2 className="font-bold text-xl" style={{ color: '#0f172a' }}>{product.name}</h2>
            <span className="text-xs px-2 py-1 rounded-full" style={{ background: '#e8f0fb', color: '#4a90e2' }}>{product.category}</span>
          </div>
          <p className="text-sm mb-4 leading-relaxed" style={{ color: '#64748b' }}>{product.description}</p>
          <div className="flex gap-4 mb-3 text-sm">
            <div>
              <div className="text-xs mb-0.5" style={{ color: '#94a3b8' }}>Price</div>
              <div className="font-bold" style={{ color: '#4a90e2' }}>{fmtPrice(product.price)}</div>
            </div>
            <div>
              <div className="text-xs mb-0.5" style={{ color: '#94a3b8' }}>Weight</div>
              <div className="font-semibold">{fmtWeight(product.weight)}</div>
            </div>
            <div>
              <div className="text-xs mb-0.5" style={{ color: '#94a3b8' }}>Total</div>
              <div className="font-semibold">{fmtPrice(product.price * qty)}</div>
            </div>
          </div>
          <div className="mb-4">
            <WeightBar current={cartWeight + product.weight * qty} max={MAX_WEIGHT} />
          </div>
          {cartWeight >= MAX_WEIGHT ? (
            <p className="text-sm mb-4 font-medium" style={{ color: '#ef4444' }}>⚠ Cart is at weight limit ({fmtWeight(MAX_WEIGHT)})</p>
          ) : null}
          <div className="flex items-center gap-3 mb-5">
            <div className="flex items-center rounded-lg overflow-hidden border" style={{ borderColor: '#e2e8f0' }}>
              <button onClick={() => setQty(q => Math.max(1, q - 1))} className="px-3 py-2 text-lg font-bold hover:bg-gray-50 transition-colors" style={{ color: '#4a90e2' }}>−</button>
              <span className="px-4 py-2 font-semibold text-sm min-w-[2.5rem] text-center">{qty}</span>
              <button onClick={() => setQty(q => Math.min(maxQty, q + 1))} className="px-3 py-2 text-lg font-bold hover:bg-gray-50 transition-colors" style={{ color: '#4a90e2' }}>+</button>
            </div>
            <button
              onClick={() => { onAddToCart(product, qty); onClose() }}
              disabled={wouldExceed || cartWeight >= MAX_WEIGHT}
              className="flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all"
              style={{
                background: wouldExceed || cartWeight >= MAX_WEIGHT ? '#e2e8f0' : '#4a90e2',
                color: wouldExceed || cartWeight >= MAX_WEIGHT ? '#94a3b8' : '#fff'
              }}
            >
              {wouldExceed ? 'Exceeds weight limit' : 'Add to Cart'}
            </button>
          </div>
          <button onClick={onClose} className="w-full py-2 text-sm rounded-lg transition-colors hover:bg-gray-50" style={{ color: '#64748b', border: '1px solid #e2e8f0' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Drone Map ────────────────────────────────────────────────────────────────

function DroneMap({ progress, status, noFlyActive }: { progress: number; status: DeliveryStatus; noFlyActive: boolean }) {
  const { x: droneX, y: droneY } = dronePosition(progress)

  // city blocks snapped to gaps between streets (each street center±9 is road)
  // Cols: x=89–151 (w=62), x=169–241 (w=72), x=259–351 (w=92), x=369–431 (w=62)
  // Rows: y=69–121 (h=52), y=139–191 (h=52), y=209–261 (h=52)
  const blocks = [
    { x: 89, y: 69, w: 62, h: 52 }, { x: 169, y: 69, w: 72, h: 52 }, { x: 259, y: 69, w: 92, h: 52 },
    { x: 89, y: 139, w: 62, h: 52 },                                   { x: 259, y: 139, w: 92, h: 52 }, { x: 369, y: 139, w: 62, h: 52 },
    { x: 89, y: 209, w: 62, h: 52 }, { x: 169, y: 209, w: 72, h: 52 }, { x: 259, y: 209, w: 92, h: 52 }, { x: 369, y: 209, w: 62, h: 52 },
  ]

  return (
    <svg width={MAP_W} height={MAP_H} className="w-full h-full" viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
      {/* background */}
      <rect width={MAP_W} height={MAP_H} fill="#d4e4f7" rx="8" />

      {/* street grid */}
      {STREETS_H.map(y => <line key={`h${y}`} x1="0" y1={y} x2={MAP_W} y2={y} stroke="#b8cfe8" strokeWidth="18" />)}
      {STREETS_V.map(x => <line key={`v${x}`} x1={x} y1="0" x2={x} y2={MAP_H} stroke="#b8cfe8" strokeWidth="18" />)}

      {/* city blocks */}
      {blocks.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="#c5d8ef" rx="3" />
      ))}

      {/* park area — top-right block cell */}
      <rect x="369" y="69" width="62" height="52" fill="#a8d5a2" rx="3" />
      <text x="400" y="98" textAnchor="middle" fontSize="14">🌳</text>

      {/* no-fly zone */}
      <rect x={NFZ.x} y={NFZ.y} width={NFZ.w} height={NFZ.h}
        fill={noFlyActive ? '#ef4444' : '#ef444422'}
        opacity={noFlyActive ? 0.25 : 1}
        stroke="#ef4444" strokeWidth="1.5" strokeDasharray="4,3" rx="3" />
      <text x={NFZ.x + NFZ.w / 2} y={NFZ.y + NFZ.h / 2 + 3} textAnchor="middle" fontSize="8"
        fill={noFlyActive ? '#c00' : '#ef444488'} fontWeight="700">NO-FLY</text>

      {/* planned flight path (dashed) */}
      <polyline
        points={FULL_PATH_POINTS}
        fill="none" stroke="#4a90e2" strokeWidth="2" strokeDasharray="7,5" opacity="0.4"
      />
      {/* flown portion */}
      <polyline
        points={flownPathPoints(progress)}
        fill="none" stroke="#4a90e2" strokeWidth="2.5" opacity="0.85"
      />

      {/* warehouse */}
      <circle cx={WAREHOUSE.x} cy={WAREHOUSE.y} r="14" fill="#1a2f5e" stroke="#fff" strokeWidth="2" />
      <text x={WAREHOUSE.x} y={WAREHOUSE.y + 5} textAnchor="middle" fontSize="13">🏪</text>
      <text x={WAREHOUSE.x} y={WAREHOUSE.y + 26} textAnchor="middle" fontSize="9" fill="#1a2f5e" fontWeight="600">STORE</text>

      {/* destination */}
      <circle cx={DESTINATION.x} cy={DESTINATION.y} r="14" fill={status === 'arrived' || status === 'confirmed' ? '#22c55e' : '#64748b'} stroke="#fff" strokeWidth="2" />
      <text x={DESTINATION.x} y={DESTINATION.y + 5} textAnchor="middle" fontSize="13">🏠</text>
      <text x={DESTINATION.x} y={DESTINATION.y + 26} textAnchor="middle" fontSize="9" fill="#0f172a" fontWeight="600">YOUR HOME</text>

      {/* drone */}
      {status === 'in-flight' && (
        <g transform={`translate(${droneX}, ${droneY})`}>
          <circle r="16" fill="#fff" stroke="#4a90e2" strokeWidth="2.5" opacity="0.95" />
          <text y="6" textAnchor="middle" fontSize="18">🚁</text>
        </g>
      )}
    </svg>
  )
}

// ── Tracking Page ────────────────────────────────────────────────────────────

function TrackingPage({
  order, status, progress, delaySchedule, onConfirmDelivery, onAbortDelivery
}: {
  order: Order | null
  status: DeliveryStatus
  progress: number
  delaySchedule: DelaySchedule
  onConfirmDelivery: () => void
  onAbortDelivery: () => void
}) {
  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20">
        <div className="text-6xl mb-4">📦</div>
        <h2 className="text-xl font-bold mb-2" style={{ color: '#0f172a' }}>No Active Delivery</h2>
        <p className="text-sm" style={{ color: '#64748b' }}>Place an order to start tracking your drone delivery.</p>
      </div>
    )
  }

  const totalSecs = totalDeliverySeconds(delaySchedule.weather)
  const simEta = new Date(order.orderedAt.getTime() + totalSecs * 1000)
  const simTimeLeft = Math.max(0, Math.ceil((simEta.getTime() - Date.now()) / 1000))

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Current Delivery Panel */}
        <div className="w-56 flex flex-col gap-3 flex-shrink-0">
          <div className="rounded-xl p-4 flex-1" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
            <h3 className="font-bold text-sm mb-3 flex items-center gap-2" style={{ color: '#0f172a' }}>
              <span>📋</span> Current Delivery
            </h3>
            <div className="space-y-2 overflow-y-auto max-h-48">
              {order.items.map(({ product, qty }) => (
                <div key={product.id} className="flex items-center gap-2 py-1.5 border-b" style={{ borderColor: '#f1f5f9' }}>
                  <span className="text-xl">{product.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{product.name}</div>
                    <div className="text-xs" style={{ color: '#94a3b8' }}>×{qty} · {fmtPrice(product.price * qty)}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t space-y-1" style={{ borderColor: '#e2e8f0' }}>
              <WeightBar current={order.weight} max={MAX_WEIGHT} />
              <div className="flex justify-between text-xs mt-2">
                <span style={{ color: '#64748b' }}>Total</span>
                <span className="font-bold" style={{ color: '#0f172a' }}>{fmtPrice(order.total)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Map */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          <div className="rounded-xl overflow-hidden flex-1" style={{ border: '1px solid #e2e8f0', minHeight: '200px' }}>
            <DroneMap progress={progress} status={status} noFlyActive={status === 'in-flight' && progress < NFZ_CLEAR_PROGRESS} />
          </div>
        </div>

        {/* Details Panel */}
        <div className="w-52 flex flex-col gap-3 flex-shrink-0">
          <div className="rounded-xl p-4" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
            <h3 className="font-bold text-sm mb-3" style={{ color: '#0f172a' }}>Details</h3>
            <div className="space-y-2 text-xs">
              <div>
                <div style={{ color: '#94a3b8' }}>Ordered at</div>
                <div className="font-semibold">{order.orderedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8' }}>ETA (simulated)</div>
                <div className="font-semibold">{simTimeLeft > 0 ? `~${simTimeLeft} min` : 'Arrived!'}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8' }}>Destination</div>
                <div className="font-semibold leading-tight">{order.address}</div>
              </div>
              <div>
                <div style={{ color: '#94a3b8' }}>Status</div>
                {status === 'in-flight' && <StatusBadge label="In Flight" color="#4a90e2" />}
                {status === 'arrived' && <StatusBadge label="Arrived" color="#22c55e" />}
                {status === 'confirmed' && <StatusBadge label="Delivered" color="#22c55e" />}
              </div>
            </div>
          </div>

          {(() => {
            const nfzActive     = status === 'in-flight' && progress < NFZ_CLEAR_PROGRESS
            const batteryActive = isBatteryActive(delaySchedule.lowBattery, progress)
            const weatherActive = isWeatherActive(delaySchedule.weather, progress)
            const delays = [
              { label: 'No-Fly Zone',  color: '#ef4444', active: nfzActive },
              { label: 'Low Battery',  color: '#eab308', active: batteryActive },
              { label: 'Weather',      color: '#4a90e2', active: weatherActive },
            ].filter(d => d.active)
            return delays.length > 0 ? (
              <div className="rounded-xl p-4" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
                <h3 className="font-bold text-xs mb-3" style={{ color: '#64748b' }}>Delays</h3>
                <div className="space-y-2">
                  {delays.map(d => (
                    <div key={d.label} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: d.color }} />
                      <span className="text-xs font-medium" style={{ color: d.color }}>{d.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null
          })()}

          {status === 'in-flight' && (
            <button
              onClick={onAbortDelivery}
              className="w-full py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90"
              style={{ background: '#ef4444', color: '#fff' }}
            >
              Abort Delivery
            </button>
          )}
        </div>
      </div>

      {/* Arrival confirmation modal */}
      {status === 'arrived' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,29,58,0.7)' }}>
          <div className="rounded-2xl shadow-2xl p-8 w-full max-w-xs mx-4 text-center" style={{ background: '#fff' }}>
            <div className="text-5xl mb-3">📦</div>
            <h2 className="text-xl font-bold mb-1" style={{ color: '#0f172a' }}>Confirm Delivery</h2>
            <p className="text-sm mb-6" style={{ color: '#64748b' }}>Package Received?</p>
            <div className="flex gap-3">
              <button
                onClick={onAbortDelivery}
                className="flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all"
                style={{ background: '#ef4444', color: '#fff' }}
              >
                Abort
              </button>
              <button
                onClick={onConfirmDelivery}
                className="flex-1 py-2.5 rounded-lg font-semibold text-sm transition-all"
                style={{ background: '#22c55e', color: '#fff' }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {status === 'confirmed' && (
        <div className="mt-4 rounded-xl p-4 text-center" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
          <div className="text-2xl mb-1">✅</div>
          <p className="font-semibold text-sm" style={{ color: '#15803d' }}>Delivery confirmed! Enjoy your groceries.</p>
        </div>
      )}
    </div>
  )
}

// ── Checkout Field ───────────────────────────────────────────────────────────

type CheckoutForm = { firstName: string; lastName: string; address: string; city: string; zip: string; cardNumber: string; cardExpiry: string; cardCvv: string }

function CheckoutField({ name, label, placeholder, half, value, error, onChange }: {
  name: keyof CheckoutForm; label: string; placeholder: string; half?: boolean
  value: string; error?: string; onChange: (name: keyof CheckoutForm, value: string) => void
}) {
  return (
    <div className={half ? 'flex-1 min-w-0' : 'w-full'}>
      <label className="block text-xs font-medium mb-1" style={{ color: '#64748b' }}>{label}</label>
      <input
        className="w-full px-3 py-2 rounded-lg text-sm transition-colors outline-none"
        style={{ border: `1px solid ${error ? '#ef4444' : '#e2e8f0'}`, background: '#fff', color: '#0f172a' }}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(name, e.target.value)}
      />
      {error && <p className="text-xs mt-0.5" style={{ color: '#ef4444' }}>{error}</p>}
    </div>
  )
}

// ── Checkout Page ────────────────────────────────────────────────────────────

function CheckoutPage({ items, onPlaceOrder, onBack }: {
  items: CartItem[]
  onPlaceOrder: (address: string) => void
  onBack: () => void
}) {
  const [form, setForm] = useState<CheckoutForm>({
    firstName: '', lastName: '', address: '', city: '', zip: '',
    cardNumber: '', cardExpiry: '', cardCvv: ''
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const total = items.reduce((s, i) => s + i.product.price * i.qty, 0)
  const weight = items.reduce((s, i) => s + i.product.weight * i.qty, 0)

  function validate() {
    const e: Record<string, string> = {}
    if (!form.firstName) e.firstName = 'Required'
    if (!form.lastName) e.lastName = 'Required'
    if (!form.address) e.address = 'Required'
    if (!form.city) e.city = 'Required'
    if (!form.zip || !/^\d{5}$/.test(form.zip)) e.zip = '5-digit ZIP'
    if (!form.cardNumber || form.cardNumber.replace(/\s/g,'').length < 16) e.cardNumber = 'Invalid'
    if (!form.cardExpiry || !/^\d{2}\/\d{2}$/.test(form.cardExpiry)) e.cardExpiry = 'MM/YY'
    if (!form.cardCvv || form.cardCvv.length < 3) e.cardCvv = 'Invalid'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSubmit() {
    if (validate()) onPlaceOrder(`${form.address}, ${form.city} ${form.zip}`)
  }

  function handleChange(name: keyof CheckoutForm, value: string) {
    setForm(f => ({ ...f, [name]: value }))
  }

  return (
    <div className="flex gap-6 h-full overflow-y-auto">
      <div className="flex-1 space-y-6">
        <div className="rounded-xl p-5" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
          <h3 className="font-bold text-base mb-4" style={{ color: '#0f172a' }}>Shipping Address</h3>
          <div className="space-y-3">
            <div className="flex gap-3">
              <CheckoutField name="firstName" label="First Name" placeholder="Jane" half value={form.firstName} error={errors.firstName} onChange={handleChange} />
              <CheckoutField name="lastName" label="Last Name" placeholder="Smith" half value={form.lastName} error={errors.lastName} onChange={handleChange} />
            </div>
            <CheckoutField name="address" label="Street Address" placeholder="123 Maple Ave" value={form.address} error={errors.address} onChange={handleChange} />
            <div className="flex gap-3">
              <CheckoutField name="city" label="City" placeholder="Springfield" half value={form.city} error={errors.city} onChange={handleChange} />
              <CheckoutField name="zip" label="ZIP Code" placeholder="12345" half value={form.zip} error={errors.zip} onChange={handleChange} />
            </div>
          </div>
        </div>

        <div className="rounded-xl p-5" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
          <h3 className="font-bold text-base mb-4" style={{ color: '#0f172a' }}>Payment</h3>
          <div className="space-y-3">
            <CheckoutField name="cardNumber" label="Card Number" placeholder="1234 5678 9012 3456" value={form.cardNumber} error={errors.cardNumber} onChange={handleChange} />
            <div className="flex gap-3">
              <CheckoutField name="cardExpiry" label="Expiry" placeholder="MM/YY" half value={form.cardExpiry} error={errors.cardExpiry} onChange={handleChange} />
              <CheckoutField name="cardCvv" label="CVV" placeholder="123" half value={form.cardCvv} error={errors.cardCvv} onChange={handleChange} />
            </div>
          </div>
        </div>
      </div>

      <div className="w-64 flex-shrink-0 flex flex-col gap-4">
        <div className="rounded-xl p-4" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
          <h3 className="font-bold text-sm mb-3" style={{ color: '#0f172a' }}>Order Summary</h3>
          <div className="space-y-2 mb-3">
            {items.map(({ product, qty }) => (
              <div key={product.id} className="flex items-center gap-2 text-sm">
                <span>{product.emoji}</span>
                <span className="flex-1 truncate text-xs">{product.name} ×{qty}</span>
                <span className="text-xs font-semibold">{fmtPrice(product.price * qty)}</span>
              </div>
            ))}
          </div>
          <div className="pt-3 border-t space-y-2" style={{ borderColor: '#e2e8f0' }}>
            <WeightBar current={weight} max={MAX_WEIGHT} />
            <div className="flex justify-between text-sm">
              <span style={{ color: '#64748b' }}>Subtotal</span>
              <span>{fmtPrice(total)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span style={{ color: '#64748b' }}>Delivery</span>
              <span className="font-medium" style={{ color: '#22c55e' }}>Free</span>
            </div>
            <div className="flex justify-between text-sm font-bold border-t pt-2" style={{ borderColor: '#e2e8f0' }}>
              <span>Total</span>
              <span>{fmtPrice(total)}</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl p-4" style={{ background: '#e8f0fb', border: '1px solid #c3d9f7' }}>
          <div className="text-xs font-medium mb-1" style={{ color: '#4a90e2' }}>🚁 Estimated Delivery</div>
          <div className="font-bold text-sm" style={{ color: '#1a2f5e' }}>~{DELIVERY_SECONDS} minutes</div>
          <div className="text-xs mt-0.5" style={{ color: '#64748b' }}>via drone to your address</div>
        </div>

        <button
          onClick={handleSubmit}
          className="w-full py-3 rounded-xl font-bold text-sm transition-all hover:opacity-90 hover:shadow-lg"
          style={{ background: '#4a90e2', color: '#fff' }}
        >
          Place Order
        </button>
        <button onClick={onBack} className="w-full py-2 rounded-xl text-sm" style={{ color: '#64748b' }}>
          ← Back to Cart
        </button>
      </div>
    </div>
  )
}

// ── Cart Panel ───────────────────────────────────────────────────────────────

function CartPanel({
  items, onUpdateQty, onRemove, onCheckout, onClose
}: {
  items: CartItem[]
  onUpdateQty: (id: number, qty: number) => void
  onRemove: (id: number) => void
  onCheckout: () => void
  onClose: () => void
}) {
  const total = items.reduce((s, i) => s + i.product.price * i.qty, 0)
  const weight = items.reduce((s, i) => s + i.product.weight * i.qty, 0)

  return (
    <div className="fixed inset-0 z-40 flex" style={{ background: 'rgba(15,29,58,0.5)' }} onClick={onClose}>
      <div className="ml-auto h-full w-80 flex flex-col shadow-2xl" style={{ background: '#fff' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="font-bold text-lg" style={{ color: '#0f172a' }}>Cart</h2>
          <button onClick={onClose} className="text-xl" style={{ color: '#94a3b8' }}>×</button>
        </div>

        {items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center">
            <div className="text-4xl mb-3">🛒</div>
            <p className="text-sm" style={{ color: '#64748b' }}>Your cart is empty</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {items.map(({ product, qty }) => (
                <div key={product.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: '#f5f7fa' }}>
                  <span className="text-2xl">{product.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">{product.name}</div>
                    <div className="text-xs" style={{ color: '#64748b' }}>{fmtPrice(product.price)} · {fmtWeight(product.weight)}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => qty === 1 ? onRemove(product.id) : onUpdateQty(product.id, qty - 1)}
                      className="w-6 h-6 rounded flex items-center justify-center text-sm font-bold hover:bg-white transition-colors"
                      style={{ color: '#4a90e2' }}>−</button>
                    <span className="w-5 text-center text-sm font-semibold">{qty}</span>
                    <button onClick={() => onUpdateQty(product.id, qty + 1)}
                      className="w-6 h-6 rounded flex items-center justify-center text-sm font-bold hover:bg-white transition-colors"
                      style={{ color: '#4a90e2' }}>+</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t space-y-3" style={{ borderColor: '#e2e8f0' }}>
              <WeightBar current={weight} max={MAX_WEIGHT} />
              <div className="flex justify-between font-bold text-sm">
                <span>Total</span>
                <span>{fmtPrice(total)}</span>
              </div>
              <button
                onClick={onCheckout}
                className="w-full py-3 rounded-xl font-bold text-sm transition-all hover:opacity-90"
                style={{ background: '#4a90e2', color: '#fff' }}
              >
                Checkout →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Shop Page ────────────────────────────────────────────────────────────────

function ShopPage({
  cart, onAddToCart, onOpenCart, onSelectProduct, selectedProduct, onCloseProduct
}: {
  cart: CartItem[]
  onAddToCart: (product: Product, qty: number) => void
  onOpenCart: () => void
  onSelectProduct: (p: Product) => void
  selectedProduct: Product | null
  onCloseProduct: () => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const categories = ['All', ...Array.from(new Set(PRODUCTS.map(p => p.category)))]
  const cartCount = cart.reduce((s, i) => s + i.qty, 0)
  const cartWeight = cart.reduce((s, i) => s + i.product.weight * i.qty, 0)

  const filtered = PRODUCTS.filter(p => {
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = category === 'All' || p.category === category
    return matchSearch && matchCat
  })

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: '#94a3b8' }}>🔍</span>
          <input
            className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none transition-colors"
            style={{ background: '#fff', border: '1px solid #e2e8f0', color: '#0f172a' }}
            placeholder="Search products..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1 overflow-x-auto">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all"
              style={{
                background: category === cat ? '#4a90e2' : '#fff',
                color: category === cat ? '#fff' : '#64748b',
                border: `1px solid ${category === cat ? '#4a90e2' : '#e2e8f0'}`
              }}
            >
              {cat}
            </button>
          ))}
        </div>
        <button
          onClick={onOpenCart}
          className="relative flex flex-col items-center px-4 py-1.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 flex-shrink-0"
          style={{ background: '#4a90e2', color: '#fff' }}
        >
          <span className="flex items-center gap-1.5">🛒 Cart</span>
          <span className="text-[10px] font-normal opacity-90">
            {cartWeight.toFixed(2)} / {MAX_WEIGHT} lb
          </span>
          {cartCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full text-xs font-bold"
              style={{ background: '#ef4444', color: '#fff' }}>{cartCount}</span>
          )}
        </button>
      </div>

      {/* Weight warning */}
      {cartWeight >= MAX_WEIGHT && (
        <div className="mb-3 px-4 py-2 rounded-lg text-sm font-medium" style={{ background: '#fef2f2', color: '#ef4444', border: '1px solid #fecaca' }}>
          ⚠ Cart is at the 5 lb weight limit. Remove items to add more.
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {filtered.map(p => (
            <ProductCard key={p.id} product={p} onSelect={() => onSelectProduct(p)} />
          ))}
          {filtered.length === 0 && (
            <div className="col-span-4 py-12 text-center">
              <div className="text-4xl mb-2">🔍</div>
              <p className="text-sm" style={{ color: '#64748b' }}>No products found</p>
            </div>
          )}
        </div>
      </div>

      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          cartWeight={cartWeight}
          onClose={onCloseProduct}
          onAddToCart={onAddToCart}
        />
      )}
    </div>
  )
}

// ── Account Page ─────────────────────────────────────────────────────────────

function AccountPage() {
  return (
    <div className="max-w-md">
      <div className="rounded-2xl p-6" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-full flex items-center justify-center text-3xl" style={{ background: '#e8f0fb' }}>👤</div>
          <div>
            <div className="font-bold text-lg" style={{ color: '#0f172a' }}>Jane Smith</div>
            <div className="text-sm" style={{ color: '#64748b' }}>jane.smith@example.com</div>
            <StatusBadge label="Premium Member" color="#4a90e2" />
          </div>
        </div>
        <div className="space-y-3">
          {[
            { label: 'Orders Placed', value: '12' },
            { label: 'Member Since', value: 'Jan 2024' },
          ].map(row => (
            <div key={row.label} className="flex justify-between text-sm py-2 border-b" style={{ borderColor: '#f1f5f9' }}>
              <span style={{ color: '#64748b' }}>{row.label}</span>
              <span className="font-semibold" style={{ color: '#0f172a' }}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<Page>('shop')
  const [cart, setCart] = useState<CartItem[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [checkout, setCheckout] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [order, setOrder] = useState<Order | null>(null)
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatus>('idle')
  const [droneProgress, setDroneProgress] = useState(0)
  const [delaySchedule, setDelaySchedule] = useState<DelaySchedule>({ lowBattery: null, weather: null })
  const animRef = useRef<number | null>(null)
  const startTimeRef = useRef<number>(0)
  const delayScheduleRef = useRef<DelaySchedule>({ lowBattery: null, weather: null })

  const cartWeight = cart.reduce((s, i) => s + i.product.weight * i.qty, 0)

  function addToCart(product: Product, qty: number) {
    const newWeight = cartWeight + product.weight * qty
    if (newWeight > MAX_WEIGHT) return
    setCart(prev => {
      const existing = prev.find(i => i.product.id === product.id)
      if (existing) return prev.map(i => i.product.id === product.id ? { ...i, qty: i.qty + qty } : i)
      return [...prev, { product, qty }]
    })
  }

  function updateQty(id: number, qty: number) {
    const item = cart.find(i => i.product.id === id)
    if (!item) return
    const delta = (qty - item.qty) * item.product.weight
    if (cartWeight + delta > MAX_WEIGHT && delta > 0) return
    setCart(prev => prev.map(i => i.product.id === id ? { ...i, qty } : i))
  }

  function removeFromCart(id: number) {
    setCart(prev => prev.filter(i => i.product.id !== id))
  }

  function placeOrder(address: string) {
    const now = new Date()
    const eta = new Date(now.getTime() + DELIVERY_SECONDS * 1000)
    const newOrder: Order = {
      items: [...cart],
      total: cart.reduce((s, i) => s + i.product.price * i.qty, 0),
      weight: cartWeight,
      orderedAt: now,
      eta,
      address,
    }
    setOrder(newOrder)
    setCart([])
    setCheckout(false)
    setCartOpen(false)
    const sched = randomDelaySchedule()
    setDelaySchedule(sched)
    delayScheduleRef.current = sched
    setDeliveryStatus('in-flight')
    setDroneProgress(0)
    startTimeRef.current = Date.now()
    setPage('tracking')
  }

  // Drone animation loop
  useEffect(() => {
    if (deliveryStatus !== 'in-flight') return

    function tick() {
      const elapsed = (Date.now() - startTimeRef.current) / 1000
      const progress = progressFromElapsed(elapsed, delayScheduleRef.current.weather)
      setDroneProgress(progress)
      if (progress >= 1) {
        setDeliveryStatus('arrived')
      } else {
        animRef.current = requestAnimationFrame(tick)
      }
    }
    animRef.current = requestAnimationFrame(tick)
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current) }
  }, [deliveryStatus])

  function confirmDelivery() {
    setDeliveryStatus('confirmed')
  }

  function abortDelivery() {
    setDeliveryStatus('idle')
    setOrder(null)
    setDroneProgress(0)
    setDelaySchedule({ lowBattery: null, weather: null })
  }

  const navItems: { id: Page; label: string; emoji: string }[] = [
    { id: 'shop', label: 'Order', emoji: '🛍️' },
    { id: 'tracking', label: 'Tracking', emoji: '🚁' },
    { id: 'account', label: 'Account', emoji: '👤' },
  ]

  return (
    <div className="min-h-screen flex" style={{ background: '#0f1d3a', fontFamily: "'Inter', sans-serif" }}>
      {/* Sidebar */}
      <nav className="w-20 flex flex-col items-center py-8 gap-6 flex-shrink-0" style={{ background: '#0a1428' }}>
        <div className="text-2xl mb-2">🚁</div>
        {navItems.map(item => (
          <button
            key={item.id}
            onClick={() => setPage(item.id)}
            className="flex flex-col items-center gap-1 w-full px-2 py-3 rounded-xl transition-all"
            style={{
              background: page === item.id ? '#1a2f5e' : 'transparent',
              color: page === item.id ? '#4a90e2' : '#64748b',
            }}
          >
            <span className="text-xl">{item.emoji}</span>
            <span className="text-xs font-medium">{item.label}</span>
          </button>
        ))}
        {deliveryStatus === 'in-flight' && (
          <div className="mt-auto">
            <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#4a90e2' }} />
          </div>
        )}
      </nav>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid #1a2f5e' }}>
          <div>
            <h1 className="font-bold text-lg text-white">
              {page === 'shop' && (checkout ? 'Checkout' : 'Order Groceries')}
              {page === 'tracking' && 'Drone Tracking'}
              {page === 'account' && 'My Account'}
            </h1>
            <p className="text-xs" style={{ color: '#64748b' }}>
              {page === 'shop' && 'Max payload: 5 lbs · Free delivery'}
              {page === 'tracking' && '1 second = 1 simulated minute'}
              {page === 'account' && 'Manage your profile'}
            </p>
          </div>
          {deliveryStatus === 'in-flight' && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: '#1a2f5e' }}>
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#4a90e2' }} />
              <span className="text-xs font-medium text-white">Delivery in progress</span>
            </div>
          )}
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-hidden p-6 rounded-t-2xl" style={{ background: '#f5f7fa' }}>
          {page === 'shop' && !checkout && (
            <ShopPage
              cart={cart}
              onAddToCart={addToCart}
              onOpenCart={() => setCartOpen(true)}
              onSelectProduct={setSelectedProduct}
              selectedProduct={selectedProduct}
              onCloseProduct={() => setSelectedProduct(null)}
            />
          )}
          {page === 'shop' && checkout && (
            <CheckoutPage
              items={cart}
              onPlaceOrder={placeOrder}
              onBack={() => setCheckout(false)}
            />
          )}
          {page === 'tracking' && (
            <TrackingPage
              order={order}
              status={deliveryStatus}
              progress={droneProgress}
              delaySchedule={delaySchedule}
              onConfirmDelivery={confirmDelivery}
              onAbortDelivery={abortDelivery}
            />
          )}
          {page === 'account' && <AccountPage />}
        </main>
      </div>

      {/* Cart slide-over */}
      {cartOpen && (
        <CartPanel
          items={cart}
          onUpdateQty={updateQty}
          onRemove={removeFromCart}
          onCheckout={() => { setCartOpen(false); setCheckout(true) }}
          onClose={() => setCartOpen(false)}
        />
      )}
    </div>
  )
}
