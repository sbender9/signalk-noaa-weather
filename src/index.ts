/*
 * Copyright 2020 Scott Bender <scott@scottbender.net>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const fetch = require('node-fetch')
const camelCase = require('camelcase')

const api = 'https://api.weather.gov'

///points/39.0631,-76.4872/stations

const directionMap: { [key: string]: number } = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315
}

export default function (app: any) {
  const error = app.error
  const debug = app.debug
  let timers: any = []
  let sentMetaPaths: any = {}
  let hardStationName: string
  let defaulMethod: string[]

  const plugin: Plugin = {
    start: function (props: any) {
      setTimeout(() => {
        getObservations(props)
      }, 5000)
      timers.push(
        setInterval(() => {
          getObservations(props)
        }, (props.observationsInterval || 60) * 1000)
      )

      setTimeout(() => {
        getForecast(props)
      }, 5000)
      timers.push(
        setInterval(() => {
          getForecast(props)
        }, (props.forcastInterval || 60 * 60) * 1000)
      )

      if (props.sendNotifications && props.notificationStates) {
        setTimeout(() => {
          sendNotifications(props)
        }, 5000)
        timers.push(
          setInterval(() => {
            sendNotifications(props)
          }, (props.notificationsInterval || 60 * 60) * 1000)
        )
      }
      if (typeof props.notificationVisual !== 'undefined') {
        defaulMethod = []
        if (props.notificationVisual) {
          defaulMethod.push('visual')
        }
        if (props.notificationSound) {
          defaulMethod.push('sound')
        }
      } else {
        defaulMethod = ['visual', 'sound']
      }
    },

    stop: function () {
      timers.forEach((timer: any) => {
        clearInterval(timer)
      })
      timers = []
    },

    id: 'signalk-noaa-weather',
    name: 'NOAA Weather',
    description:
      'Signal K Plugin to get current weather and forecast from NOAA',
    schema: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          title: 'Observation Station',
          description: 'NOAA Station Name (leave blank to use the closest)'
        },
        forcastStation: {
          type: 'string',
          title: 'Forcast Station',
          description: 'NOAA Station Name (leave blank to use the closest)'
        },
        sendNotifications: {
          type: 'boolean',
          title: 'Send Notifications',
          default: true
        },
        notificationStates: {
          type: 'string',
          title: 'Notification States',
          description: 'Comma separated list of US state abbreviations',
          default: 'MD'
        },
        notificationVisual: {
          type: 'boolean',
          title: 'Notification Method Visual',
          default: true
        },
        notificationSound: {
          type: 'boolean',
          title: 'Notification Method Sound',
          default: true
        },
        notificationState: {
          type: 'string',
          title: 'Notification State',
          enum: ['normal', 'alert', 'warn', 'alarm', 'emergency'],
          default: 'alert'
        },
        forcastInterval: {
          type: 'number',
          title: 'Forecast Interval',
          description: 'in seconds',
          default: 60 * 60
        },
        observationsInterval: {
          type: 'number',
          title: 'Observations Interval',
          description: 'in seconds',
          default: 60
        },
        notificationsInterval: {
          type: 'number',
          title: 'Notifications Interval',
          description: 'in seconds',
          default: 60
        }
      }
    }
  }

  function getStation (props: any) {
    if (props.station && props.station.length > 0) {
      if (hardStationName) {
        return Promise.resolve({ id: props.station, name: hardStationName })
      } else {
        return new Promise((resolve, reject) => {
          fetch(api + `/stations/${props.station}`)
            .then((r: any) => r.json())
            .then((json: any) => {
              resolve({ id: props.station, name: json.properties.name })
            })
            .catch(reject)
        })
      }
    } else {
      return new Promise((resolve, reject) => {
        const position = app.getSelfPath('navigation.position')
        if (position && position.value) {
          fetch(
            api +
              `/points/${position.value.latitude.toFixed(
                4
              )},${position.value.longitude.toFixed(4)}/stations`
          )
            .then((r: any) => r.json())
            .then((json: any) => {
              if (json.features && json.features.length > 0) {
                let station = json.features[0]
                resolve({
                  id: station.properties.stationIdentifier,
                  name: station.properties.name
                })
              } else {
                reject(new Error('no stations found'))
              }
            })
            .catch(reject)
        } else {
          reject(new Error('no position'))
        }
      })
    }
  }

  function getObservations (props: any) {
    getStation(props)
      .then((info: any) => {
        fetch(api + `/stations/${info.id}/observations/latest`)
          .then((res: any) => {
            if (res.ok) {
              return res.json()
            } else {
              app.setPluginError(`no observations for station ${info.id}`)
              return {}
            }
          })
          .then((json: any) => {
            const values: any = []
            const metas: any = []

            if (info.name) {
              values.push({
                path: 'environment.observations.stationName',
                value: info.name
              })
            }

            if (info.id) {
              values.push({
                path: 'environment.observations.stationId',
                value: info.id
              })
            }

            if (!json.properties) return

            Object.keys(json.properties).forEach(key => {
              const data = json.properties[key]

              if (data.value) {
                //console.log(JSON.stringify(data))
                const info: any = convertUnits(data.unitCode, data.value)
                const path: string = `environment.observations.${key}`
                values.push({
                  path,
                  value: info.value
                })
                if (info.units && !sentMetaPaths[path]) {
                  sentMetaPaths[path] = true
                  metas.push({
                    path,
                    value: { units: info.units }
                  })
                }
              }
            })
            if (metas.length > 0) {
              app.handleMessage(plugin.id, {
                updates: [
                  {
                    meta: metas
                  }
                ]
              })
            }

            app.handleMessage(plugin.id, {
              updates: [
                {
                  values: values
                }
              ]
            })
          })
          .catch((err: any) => {
            app.error(err)
            app.setPluginError(err.message)
          })
      })
      .catch((err: any) => {
        app.error(err)
        app.setPluginError(err.message)
      })
  }

  function getForecast (props: any) {
    props
    const position = app.getSelfPath('navigation.position')
    if (position && position.value) {
      let url

      if (props.forcastStation) {
        url = api + `/stations/${props.forcastStation}`
      } else {
        url =
          api +
          `/points/${position.value.latitude.toFixed(
            4
          )},${position.value.longitude.toFixed(4)}`
      }
      app.debug('fetching forecast via %s', url)
      fetch(url)
        .then((r: any) => r.json())
        .then((json: any) => {
          fetch(json.properties.forecast)
            .then((r: any) => r.json())
            .then((forecast: any) => {
              let values: any = []
              let metas: any = []

              if (!forecast.properties.periods) {
                app.debug('props %j', forecast.properties)
                app.setPluginError('no forecast periods')
                return
              }

              forecast.properties.periods.forEach((period: any) => {
                const pkey = `environment.forecast.${camelCase(period.name)}`
                let windSpeed = null
                let windDirection = null

                if (period.windSpeed) {
                  windSpeed = Number(period.windSpeed.split(' ')[0]) / 2.237
                }
                if (period.windDirection) {
                  windDirection = convertDirection(period.windDirection)
                }
                values.push(
                  ...[
                    {
                      path: `${pkey}.name`,
                      value: period.name
                    },
                    {
                      path: `${pkey}.temperature`,
                      value: (period.temperature - 32) * (5 / 9) + 273.15
                    },
                    {
                      path: `${pkey}.temperatureTrend`,
                      value: period.temperatureTrend
                    },
                    {
                      path: `${pkey}.windSpeed`,
                      value: windSpeed
                    },
                    {
                      path: `${pkey}.windDirection`,
                      value: windDirection
                    },
                    {
                      path: `${pkey}.shortForecast`,
                      value: period.shortForecast
                    },
                    {
                      path: `${pkey}.detailedForecast`,
                      value: period.detailedForecast
                    },
                    {
                      path: `${pkey}.startTime`,
                      value: new Date(period.startTime).toISOString()
                    },
                    {
                      path: `${pkey}.endTime`,
                      value: new Date(period.endTime).toISOString()
                    }
                  ]
                )
                if (!sentMetaPaths[pkey]) {
                  sentMetaPaths[pkey] = true
                  metas.push(
                    ...[
                      {
                        path: `${pkey}.temperature`,
                        value: { units: 'K' }
                      },
                      {
                        path: `${pkey}.windSpeed`,
                        value: { units: 'm/s' }
                      },
                      {
                        path: `${pkey}.windDirection`,
                        value: { units: 'rad' }
                      }
                    ]
                  )
                }
              })
              if (metas.length > 0) {
                app.handleMessage(plugin.id, {
                  updates: [
                    {
                      meta: metas
                    }
                  ]
                })
              }
              app.handleMessage(plugin.id, {
                updates: [
                  {
                    values: values
                  }
                ]
              })
            })
            .catch((err: any) => {
              app.error(err)
              app.setPluginError(err.message)
            })
        })
        .catch((err: any) => {
          app.error(err)
          app.setPluginError(err.message)
        })
    }
  }

  function sendNotifications (props: any) {
    props.notificationStates.split(',').forEach((state: string) => {
      app.debug(`getting alerts for ${state}`)
      fetch(api + `/alerts/active?area=${state}&status=actual`)
        .then((r: any) => r.json())
        .then((json: any) => {
          if (!json.features) return

          const currentAlerts: any = []

          json.features.forEach((feature: any) => {
            const alert = feature.properties
            const id = alert.id.replace(/\./g, '_')
            const path = `notifications.noaa.${id}`
            const values: any = []
            const existing = app.getSelfPath(path + '.value')

            if (alert.messageType === 'Cancel') {
              if (existing) {
                app.debug('canceling %s: %s', id, existing.message)
                app.handleMessage(plugin.id, {
                  updates: [
                    {
                      values: [
                        {
                          path,
                          value: { ...existing, state: 'normal' }
                        }
                      ]
                    }
                  ]
                })
              }
            } else if (alert.messageType === 'Alert') {
              let method = defaulMethod
              if (existing && existing.state !== 'normal') {
                method = existing.method
              }
              let message = alert.headline
              if ( alert.areaDesc ) {
                message = `${message} for ${alert.areaDesc}` 
              }
              const notif = {
                sent: alert.sent,
                effective: alert.effective,
                onset: alert.onset,
                expires: alert.expires,
                ends: alert.ends,
                category: alert.category,
                severity: alert.severity,
                certainty: alert.certainty,
                urgency: alert.urgency,
                event: alert.event,
                description: alert.description,
                sourceState: state,
                id,
                message,
                state: props.notificationState || 'alert',
                method
              }
              //app.debug('sending %j', notif)
              if (!existing || existing.state === 'normal') {
                app.debug('sending %s: %s', id, message)
              }
              currentAlerts.push(id)
              app.handleMessage(plugin.id, {
                updates: [
                  {
                    values: [
                      {
                        path,
                        value: notif
                      }
                    ]
                  }
                ]
              })
            }
          })
          const existingNotifications = app.getSelfPath('notifications.noaa')
          if (existingNotifications) {
            //app.debug('existingNotifications: %j', existingNotifications)
            Object.values(existingNotifications).forEach(
              (notification: any) => {
                if (
                  notification.value.sourceState === state &&
                  currentAlerts.indexOf(notification.value.id) === -1 &&
                  notification.value.state !== 'normal'
                ) {
                  app.debug(
                    'clearing %s: %s',
                    notification.value.id,
                    notification.value.message
                  )
                  app.handleMessage(plugin.id, {
                    updates: [
                      {
                        values: [
                          {
                            path: `notifications.noaa.${notification.value.id}`,
                            value: { ...notification.value, state: 'normal' }
                          }
                        ]
                      }
                    ]
                  })
                }
              }
            )
          }
        })
        .catch((err: any) => {
          app.error(err)
          app.setPluginError(err.message)
        })
    })
  }

  function convertUnits (units: string, value: any) {
    let skUnits
    if (units === 'unit:percent') {
      value = value / 100
      skUnits = 'ratio'
    } else if (units === 'unit:degC') {
      value = value + 273.15
      skUnits = 'K'
    } else if (units === 'unit:km_h-1') {
      value = value / 3.6
      skUnits = 'm/s'
    } else if (units === 'unit:degree_(angle)') {
      value = value * (Math.PI / 180.0)
      skUnits = 'rad'
    } else if (units === 'unit:Pa') {
      skUnits = 'Pa'
    } else if (units === 'unit:m') {
      skUnits = 'm'
    }
    return { value, units: skUnits }
  }

  function convertDirection (dir: string) {
    const degrees = directionMap[dir]
    return degrees ? degrees * (Math.PI / 180.0) : null
  }

  return plugin
}

interface Plugin {
  start: (app: any) => void
  stop: () => void
  id: string
  name: string
  description: string
  schema: any
}
