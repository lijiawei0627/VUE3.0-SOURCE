import {
  effect,
  stop,
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffectOptions,
  isReactive
} from '@vue/reactivity'
import { SchedulerJob, queuePreFlushCb } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  recordInstanceBoundEffect
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? V
    : T[K] extends object ? T[K] : never
}

type MapOldSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true ? (V | undefined) : V
    : T[K] extends object
      ? Immediate extends true ? (T[K] | undefined) : T[K]
      : never
}

type InvalidateCbRegistrator = (cb: () => void) => void

export interface WatchOptionsBase {
  flush?: 'pre' | 'post' | 'sync'
  onTrack?: ReactiveEffectOptions['onTrack']
  onTrigger?: ReactiveEffectOptions['onTrigger']
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

// Simple effect.
export function watchEffect(
  effect: WatchEffect,
  options?: WatchOptionsBase
): WatchStopHandle {
  return doWatch(effect, null, options)
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

// overload #1: array of multiple sources + cb
// Readonly constraint helps the callback to correctly infer value types based
// on position in the source array. Otherwise the values will get a union type
// of all possible value types.
export function watch<
  T extends Readonly<Array<WatchSource<unknown> | object>>,
  Immediate extends Readonly<boolean> = false
>(
  sources: T,
  cb: WatchCallback<MapSources<T>, MapOldSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #2: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload #3: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? (T | undefined) : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
export function watch<T = any>(
  source: WatchSource<T> | WatchSource<T>[],
  cb: WatchCallback<T>,
  options?: WatchOptions
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source, cb, options)
}

function doWatch(
  source: WatchSource | WatchSource[] | WatchEffect,
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ,
  // 当前组件实例 
  instance = currentInstance
): WatchStopHandle {
  if (__DEV__ && !cb) {
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  // source 不合法的时候会报警告 
  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  // 标准化source，创建getter
  let getter: () => any
  const isRefSource = isRef(source)
  if (isRefSource) {
    // ref source
    getter = () => (source as Ref).value
  } else if (isReactive(source)) {
    // reactive source
    getter = () => source
    deep = true
  } else if (isArray(source)) {
    // 数组 source
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {  // function source
    if (cb) {
      // getter with cb
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
    } else {
      // no cb -> simple effect
      // watchEffect 的逻辑
      getter = () => {
        if (instance && instance.isUnmounted) {
          return
        }
        if (cleanup) {
          cleanup()
        }
        return callWithErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onInvalidate]
        )
      }
    }
  } else {
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  if (cb && deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  let cleanup: () => void
  // 注册无效回调函数 
  const onInvalidate: InvalidateCbRegistrator = (fn: () => void) => {
    cleanup = runner.options.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  if (__NODE_JS__ && isInSSRComponentSetup) {
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        undefined,
        onInvalidate
      ])
    }
    return NOOP
  }

  // 旧值初始值 
  let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE
  // 回调函数 
  const job: SchedulerJob = () => {
    // runner effect未激活直接返回
    if (!runner.active) {
      return
    }
    if (cb) {
      // 求得新值 
      // watch(source, cb)
      const newValue = runner()
      if (deep || isRefSource || hasChanged(newValue, oldValue)) {
        // cleanup before running cb again
        // 执行清理函数 
        if (cleanup) {
          cleanup()
        }
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          // 第一次更改时传递旧值为 undefined 
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
         // 更新旧值 
        oldValue = newValue
      }
    } else {
      // watchEffect
      runner()
    }
  }

  // important: mark the job as a watcher callback so that scheduler knows it
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb
  // 创建 scheduler 时序执行函数 
  let scheduler: (job: () => any) => void
  if (flush === 'sync') {
    // 同步 
    scheduler = job
  } else if (flush === 'pre') {
    // ensure it's queued before component updates (which have positive ids)
    // 进入异步队列，组件更新前执行 
    job.id = -1
    scheduler = () => {
      if (!instance || instance.isMounted) {
        queuePreFlushCb(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        // 如果组件还没挂载，则同步执行确保在组件挂载前 
        job()
      }
    }
  } else {
    // 进入异步队列，组件更新后执行 
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
  }
  // 创建 effect 副作用函数 
  const runner = effect(getter, {
    lazy: true,
    onTrack,
    onTrigger,
    scheduler
  })

  // 在组件实例中记录这个 effect 
  recordInstanceBoundEffect(runner)

  // initial run
  // 初次执行 
  if (cb) {
    if (immediate) {
      job()
    } else {
      // 求旧值 
      oldValue = runner()
    }
  } else {
    // 没有 cb 的情况 
    runner()
  }
  
  // 返回侦听器销毁函数 
  return () => {
    stop(runner)
    if (instance) {
      // 移除组件 effects 对这个 runner 的引用 
      remove(instance.effects!, runner)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  cb: Function,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? () => publicThis[source]
    : source.bind(publicThis)
  return doWatch(getter, cb.bind(publicThis), options, this)
}

function traverse(value: unknown, seen: Set<unknown> = new Set()) {
  if (!isObject(value) || seen.has(value)) {
    return value
  }
  seen.add(value)
  if (isRef(value)) {
    traverse(value.value, seen)
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (value instanceof Map) {
    value.forEach((v, key) => {
      // to register mutation dep for existing keys
      traverse(value.get(key), seen)
    })
  } else if (value instanceof Set) {
    value.forEach(v => {
      traverse(v, seen)
    })
  } else {
    for (const key in value) {
      traverse(value[key], seen)
    }
  }
  return value
}
