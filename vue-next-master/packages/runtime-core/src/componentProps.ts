import {
  toRaw,
  shallowReactive,
  trigger,
  TriggerOpTypes
} from '@vue/reactivity'
import {
  EMPTY_OBJ,
  camelize,
  hyphenate,
  capitalize,
  isString,
  isFunction,
  isArray,
  isObject,
  hasOwn,
  toRawType,
  PatchFlags,
  makeMap,
  isReservedProp,
  EMPTY_ARR,
  def,
  extend
} from '@vue/shared'
import { warn } from './warning'
import {
  Data,
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent
} from './component'
import { isEmitListener } from './componentEmits'
import { InternalObjectKey } from './vnode'
import { AppContext } from './apiCreateApp'

export type ComponentPropsOptions<P = Data> =
  | ComponentObjectPropsOptions<P>
  | string[]

export type ComponentObjectPropsOptions<P = Data> = {
  [K in keyof P]: Prop<P[K]> | null
}

export type Prop<T, D = T> = PropOptions<T, D> | PropType<T>

type DefaultFactory<T> = (props: Data) => T | null | undefined

interface PropOptions<T = any, D = T> {
  type?: PropType<T> | true | null
  required?: boolean
  default?: D | DefaultFactory<D> | null | undefined | object
  validator?(value: unknown): boolean
}

export type PropType<T> = PropConstructor<T> | PropConstructor<T>[]

type PropConstructor<T = any> =
  | { new (...args: any[]): T & object }
  | { (): T }
  | PropMethod<T>

type PropMethod<T, TConstructor = any> = T extends (...args: any) => any // if is function with args
  ? { new (): TConstructor; (): T; readonly prototype: TConstructor } // Create Function like constructor
  : never

type RequiredKeys<T, MakeDefaultRequired> = {
  [K in keyof T]: T[K] extends
    | { required: true }
    | (MakeDefaultRequired extends true ? { default: any } : never)
    ? K
    : never
}[keyof T]

type OptionalKeys<T, MakeDefaultRequired> = Exclude<
  keyof T,
  RequiredKeys<T, MakeDefaultRequired>
>

type InferPropType<T> = T extends null
  ? any // null & true would fail to infer
  : T extends { type: null | true }
    ? any // As TS issue https://github.com/Microsoft/TypeScript/issues/14829 // somehow `ObjectConstructor` when inferred from { (): T } becomes `any` // `BooleanConstructor` when inferred from PropConstructor(with PropMethod) becomes `Boolean`
    : T extends ObjectConstructor | { type: ObjectConstructor }
      ? Record<string, any>
      : T extends BooleanConstructor | { type: BooleanConstructor }
        ? boolean
        : T extends Prop<infer V, infer D> ? (unknown extends V ? D : V) : T

export type ExtractPropTypes<
  O,
  MakeDefaultRequired extends boolean = true
> = O extends object
  ? { [K in RequiredKeys<O, MakeDefaultRequired>]: InferPropType<O[K]> } &
      { [K in OptionalKeys<O, MakeDefaultRequired>]?: InferPropType<O[K]> }
  : { [K in string]: any }

const enum BooleanFlags {
  shouldCast,
  shouldCastTrue
}

type NormalizedProp =
  | null
  | (PropOptions & {
      [BooleanFlags.shouldCast]?: boolean
      [BooleanFlags.shouldCastTrue]?: boolean
    })

// normalized value is a tuple of the actual normalized options
// and an array of prop keys that need value casting (booleans and defaults)
export type NormalizedProps = Record<string, NormalizedProp>
export type NormalizedPropsOptions = [NormalizedProps, string[]] | []

export function initProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  isStateful: number, // result of bitwise flag comparison
  isSSR = false
) {
  const props: Data = {}
  const attrs: Data = {}
  def(attrs, InternalObjectKey, 1)
  // 设置 props 的值
  setFullProps(instance, rawProps, props, attrs)
  // validation
  // 验证 props 合法
  if (__DEV__) {
    validateProps(props, instance)
  }

  if (isStateful) {
    // stateful
    // 有状态组件，响应式处理
    instance.props = isSSR ? props : shallowReactive(props)
  } else {
    // 函数式组件处理
    if (!instance.type.props) {
      // functional w/ optional props, props === attrs
      instance.props = attrs
    } else {
      // functional w/ declared props
      instance.props = props
    }
  }
  // 普通属性赋值
  instance.attrs = attrs
}

export function updateProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  rawPrevProps: Data | null,
  optimized: boolean
) {
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance
  const rawCurrentProps = toRaw(props)
  const [options] = instance.propsOptions

  if (
    // always force full diff if hmr is enabled
    !(__DEV__ && instance.type.__hmrId) &&
    (optimized || patchFlag > 0) &&
    !(patchFlag & PatchFlags.FULL_PROPS)
  ) {
    if (patchFlag & PatchFlags.PROPS) {
      // Compiler-generated props & no keys change, just set the updated
      // the props.
      // 只更新动态 props 节点
      const propsToUpdate = instance.vnode.dynamicProps!
      for (let i = 0; i < propsToUpdate.length; i++) {
        const key = propsToUpdate[i]
        // PROPS flag guarantees rawProps to be non-null
        const value = rawProps![key]
        if (options) {
          // attr / props separation was done on init and will be consistent
          // in this code path, so just check if attrs have it.
          if (hasOwn(attrs, key)) {
            attrs[key] = value
          } else {
            const camelizedKey = camelize(key)
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value
            )
          }
        } else {
          attrs[key] = value
        }
      }
    }
  } else {
    // full props update.
    // 全量 props 更新
    setFullProps(instance, rawProps, props, attrs)
    // in case of dynamic props, check if we need to delete keys from
    // the props object
    // 因为新的 props 是动态的，把那些不在新的 props 中但存在于旧的 props 中的值设置为 undefined
    let kebabKey: string
    for (const key in rawCurrentProps) {
      if (
        !rawProps ||
        // for camelCase
        (!hasOwn(rawProps, key) &&
          // it's possible the original props was passed in as kebab-case
          // and converted to camelCase (#955)
          ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))
      ) {
        if (options) {
          if (
            rawPrevProps &&
            // for camelCase
            (rawPrevProps[key] !== undefined ||
              // for kebab-case
              rawPrevProps[kebabKey!] !== undefined)
          ) {
            props[key] = resolvePropValue(
              options,
              rawProps || EMPTY_OBJ,
              key,
              undefined
            )
          }
        } else {
          delete props[key]
        }
      }
    }
    // in the case of functional component w/o props declaration, props and
    // attrs point to the same object so it should already have been updated.
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (!rawProps || !hasOwn(rawProps, key)) {
          delete attrs[key]
        }
      }
    }
  }

  // trigger updates for $attrs in case it's used in component slots
  trigger(instance, TriggerOpTypes.SET, '$attrs')

  if (__DEV__ && rawProps) {
    validateProps(props, instance)
  }
}

function setFullProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  props: Data,
  attrs: Data
) {
  const [options, needCastKeys] = instance.propsOptions
  if (rawProps) {
    for (const key in rawProps) {
      const value = rawProps[key]
      // key, ref are reserved and never passed down
      // 一些保留的 prop 比如 ref、key 是不会传递的
      if (isReservedProp(key)) {
        continue
      }
      // prop option names are camelized during normalization, so to support
      // kebab -> camel conversion here we need to camelize the key.
      // 连字符形式的 props 也转成驼峰形式
      let camelKey
      if (options && hasOwn(options, (camelKey = camelize(key)))) {
        props[camelKey] = value
      } else if (!isEmitListener(instance.emitsOptions, key)) {
        // Any non-declared (either as a prop or an emitted event) props are put
        // into a separate `attrs` object for spreading. Make sure to preserve
        // original key casing
        // 非事件派发相关的，且不在 props 中定义的普通属性用 attrs 保留
        attrs[key] = value
      }
    }
  }

  if (needCastKeys) {
    // 需要做转换的 props
    const rawCurrentProps = toRaw(props)
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i]
      props[key] = resolvePropValue(
        options!,
        rawCurrentProps,
        key,
        rawCurrentProps[key]
      )
    }
  }
}

function resolvePropValue(
  options: NormalizedProps,
  props: Data,
  key: string,
  value: unknown
) {
  const opt = options[key]
  if (opt != null) {
    const hasDefault = hasOwn(opt, 'default')
    // default values
    // 默认值处理
    if (hasDefault && value === undefined) {
      const defaultValue = opt.default
      value =
        opt.type !== Function && isFunction(defaultValue)
          ? defaultValue(props)
          : defaultValue
    }
    // boolean casting
    // 布尔类型转换
    if (opt[BooleanFlags.shouldCast]) {
      if (!hasOwn(props, key) && !hasDefault) {
        value = false
      } else if (
        opt[BooleanFlags.shouldCastTrue] &&
        (value === '' || value === hyphenate(key))
      ) {
        value = true
      }
    }
  }
  return value
}

export function normalizePropsOptions(
  comp: ConcreteComponent,
  appContext: AppContext,
  asMixin = false
): NormalizedPropsOptions {
  const appId = appContext.app ? appContext.app._uid : -1
  const cache = comp.__props || (comp.__props = {})
  const cached = cache[appId]
  // cached 用于缓存标准化的结果，有缓存，则直接返回
  if (cached) {
    return cached
  }

  const raw = comp.props
  const normalized: NormalizedPropsOptions[0] = {}
  const needCastKeys: NormalizedPropsOptions[1] = []

  // apply mixin/extends props
  // 处理 mixins 和 extends 这些 props
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendProps = (raw: ComponentOptions) => {
      hasExtends = true
      // 标准化 props 的配置
      const [props, keys] = normalizePropsOptions(raw, appContext, true)
      extend(normalized, props)
      if (keys) needCastKeys.push(...keys)
    }
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps)
    }
    if (comp.extends) {
      extendProps(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendProps)
    }
  }

  if (!raw && !hasExtends) {
    return (cache[appId] = EMPTY_ARR)
  }

  // 数组形式的 props 定义
  if (isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      if (__DEV__ && !isString(raw[i])) {
        warn(`props must be strings when using array syntax.`, raw[i])
      }
      const normalizedKey = camelize(raw[i])
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ
      }
    }
  } else if (raw) {
    if (__DEV__ && !isObject(raw)) {
      warn(`invalid props options`, raw)
    }
    for (const key in raw) {
      const normalizedKey = camelize(key)
      if (validatePropName(normalizedKey)) {
        const opt = raw[key]
        // 标准化 prop 的定义格式
        const prop: NormalizedProp = (normalized[normalizedKey] =
          isArray(opt) || isFunction(opt) ? { type: opt } : opt)
        if (prop) {
          const booleanIndex = getTypeIndex(Boolean, prop.type)
          const stringIndex = getTypeIndex(String, prop.type)
          prop[BooleanFlags.shouldCast] = booleanIndex > -1
          prop[BooleanFlags.shouldCastTrue] =
            stringIndex < 0 || booleanIndex < stringIndex
          // if the prop needs boolean casting or default value
          // 布尔类型和有默认值的 prop 都需要转换
          if (booleanIndex > -1 || hasOwn(prop, 'default')) {
            needCastKeys.push(normalizedKey)
          }
        }
      }
    }
  }

  return (cache[appId] = [normalized, needCastKeys])
}

// use function string name to check type constructors
// so that it works across vms / iframes.
function getType(ctor: Prop<any>): string {
  const match = ctor && ctor.toString().match(/^\s*function (\w+)/)
  return match ? match[1] : ''
}

function isSameType(a: Prop<any>, b: Prop<any>): boolean {
  return getType(a) === getType(b)
}

function getTypeIndex(
  type: Prop<any>,
  expectedTypes: PropType<any> | void | null | true
): number {
  if (isArray(expectedTypes)) {
    for (let i = 0, len = expectedTypes.length; i < len; i++) {
      if (isSameType(expectedTypes[i], type)) {
        return i
      }
    }
  } else if (isFunction(expectedTypes)) {
    return isSameType(expectedTypes, type) ? 0 : -1
  }
  return -1
}

/**
 * dev only
 */
function validateProps(props: Data, instance: ComponentInternalInstance) {
  const rawValues = toRaw(props)
  const options = instance.propsOptions[0]
  for (const key in options) {
    let opt = options[key]
    if (opt == null) continue
    validateProp(key, rawValues[key], opt, !hasOwn(rawValues, key))
  }
}

/**
 * dev only
 */
function validatePropName(key: string) {
  if (key[0] !== '$') {
    return true
  } else if (__DEV__) {
    warn(`Invalid prop name: "${key}" is a reserved property.`)
  }
  return false
}

/**
 * dev only
 */
function validateProp(
  name: string,
  value: unknown,
  prop: PropOptions,
  isAbsent: boolean
) {
  const { type, required, validator } = prop
  // required!
  // 检测 required
  if (required && isAbsent) {
    warn('Missing required prop: "' + name + '"')
    return
  }
  // missing but optional
  // 虽然没有值但也没有配置 required，直接返回
  if (value == null && !prop.required) {
    return
  }
  // type check
  // 类型检测
  if (type != null && type !== true) {
    let isValid = false
    const types = isArray(type) ? type : [type]
    const expectedTypes = []
    // value is valid as long as one of the specified types match
    // 只要指定的类型之一匹配，值就有效
    for (let i = 0; i < types.length && !isValid; i++) {
      const { valid, expectedType } = assertType(value, types[i])
      expectedTypes.push(expectedType || '')
      isValid = valid
    }
    if (!isValid) {
      warn(getInvalidTypeMessage(name, value, expectedTypes))
      return
    }
  }
  // custom validator
  // 自定义校验器
  if (validator && !validator(value)) {
    warn('Invalid prop: custom validator check failed for prop "' + name + '".')
  }
}

const isSimpleType = /*#__PURE__*/ makeMap(
  'String,Number,Boolean,Function,Symbol'
)

type AssertionResult = {
  valid: boolean
  expectedType: string
}

/**
 * dev only
 */
function assertType(value: unknown, type: PropConstructor): AssertionResult {
  let valid
  const expectedType = getType(type)
  if (isSimpleType(expectedType)) {
    const t = typeof value
    valid = t === expectedType.toLowerCase()
    // for primitive wrapper objects
    if (!valid && t === 'object') {
      valid = value instanceof type
    }
  } else if (expectedType === 'Object') {
    valid = isObject(value)
  } else if (expectedType === 'Array') {
    valid = isArray(value)
  } else {
    valid = value instanceof type
  }
  return {
    valid,
    expectedType
  }
}

/**
 * dev only
 */
function getInvalidTypeMessage(
  name: string,
  value: unknown,
  expectedTypes: string[]
): string {
  let message =
    `Invalid prop: type check failed for prop "${name}".` +
    ` Expected ${expectedTypes.map(capitalize).join(', ')}`
  const expectedType = expectedTypes[0]
  const receivedType = toRawType(value)
  const expectedValue = styleValue(value, expectedType)
  const receivedValue = styleValue(value, receivedType)
  // check if we need to specify expected value
  if (
    expectedTypes.length === 1 &&
    isExplicable(expectedType) &&
    !isBoolean(expectedType, receivedType)
  ) {
    message += ` with value ${expectedValue}`
  }
  message += `, got ${receivedType} `
  // check if we need to specify received value
  if (isExplicable(receivedType)) {
    message += `with value ${receivedValue}.`
  }
  return message
}

/**
 * dev only
 */
function styleValue(value: unknown, type: string): string {
  if (type === 'String') {
    return `"${value}"`
  } else if (type === 'Number') {
    return `${Number(value)}`
  } else {
    return `${value}`
  }
}

/**
 * dev only
 */
function isExplicable(type: string): boolean {
  const explicitTypes = ['string', 'number', 'boolean']
  return explicitTypes.some(elem => type.toLowerCase() === elem)
}

/**
 * dev only
 */
function isBoolean(...args: string[]): boolean {
  return args.some(elem => elem.toLowerCase() === 'boolean')
}
