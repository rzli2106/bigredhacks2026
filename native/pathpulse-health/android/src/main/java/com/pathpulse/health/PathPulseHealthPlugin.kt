package com.pathpulse.health

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.*
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.*
import org.json.JSONArray
import java.time.Instant

@CapacitorPlugin(name = "PathPulseHealth")
class PathPulseHealthPlugin : Plugin(), SensorEventListener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val permissions = setOf(HealthPermission.getReadPermission(StepsRecord::class), HealthPermission.getReadPermission(SpeedRecord::class))
    private val contract = PermissionController.createRequestPermissionResultContract()
    private var monitoring = false
    private var since = Instant.now().minusSeconds(86400)
    private val main = Handler(Looper.getMainLooper())
    private var motionRequested = false
    private var motionActive = false
    private var foreground = true
    private var gyroTime = 0L
    private var gyro: FloatArray? = null
    private val sensors get() = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private fun beginMotion(): Boolean {
        if (motionActive) return true
        val accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return false
        val gyroscope = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE) ?: return false
        gyro = null; gyroTime = 0
        val gyroStarted = sensors.registerListener(this, gyroscope, 20000, main)
        val accelerationStarted = sensors.registerListener(this, accelerometer, 20000, main)
        motionActive = gyroStarted && accelerationStarted
        if (!motionActive) sensors.unregisterListener(this)
        return motionActive
    }
    private fun endMotion() { sensors.unregisterListener(this); motionActive = false; gyro = null; gyroTime = 0 }
    @PluginMethod fun startMotion(call: PluginCall) {
        main.post {
            if (sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) == null || sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE) == null) {
                call.reject("Accelerometer and gyroscope are both required."); return@post
            }
            motionRequested = true
            if (foreground && !beginMotion()) { motionRequested = false; call.reject("Native motion sensors could not start.") } else call.resolve()
        }
    }
    @PluginMethod fun stopMotion(call: PluginCall) { main.post { motionRequested = false; endMotion(); call.resolve() } }
    override fun onSensorChanged(event: SensorEvent) {
        if (!motionActive || !motionRequested || !foreground) return
        if (event.sensor.type == Sensor.TYPE_GYROSCOPE) { gyro = event.values.clone(); gyroTime = event.timestamp; return }
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
        val sample = JSObject().put("timestamp", event.timestamp / 1000000.0)
        val rotation = gyro
        // Fail closed if the gyro is missing, from the future, or more than 40 ms old.
        if (rotation != null && event.timestamp >= gyroTime && event.timestamp - gyroTime <= 40000000L) {
            val degrees = 180.0 / Math.PI
            sample.put("accelerationIncludingGravity", JSObject().put("x", event.values[0].toDouble()).put("y", event.values[1].toDouble()).put("z", event.values[2].toDouble()))
            sample.put("rotationRate", JSObject().put("alpha", rotation[2] * degrees).put("beta", rotation[0] * degrees).put("gamma", rotation[1] * degrees))
        }
        notifyListeners("motionSample", sample)
    }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    override fun handleOnPause() { foreground = false; endMotion(); super.handleOnPause() }
    override fun handleOnResume() { foreground = true; if (motionRequested) beginMotion(); super.handleOnResume() }
    private fun available() = Build.VERSION.SDK_INT >= 34 && HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE
    private fun client() = HealthConnectClient.getOrCreate(context)
    @PluginMethod fun availability(call: PluginCall) { call.resolve(JSObject().put("available", available()).put("reason", "Health Connect requires Android 14+ and an available provider.")) }
    @PluginMethod override fun requestPermissions(call: PluginCall) {
        if (!available()) { call.reject("Health Connect is unavailable. Update the system provider."); return }
        startActivityForResult(call, contract.createIntent(context, permissions), "permissionsResult")
    }
    @ActivityCallback private fun permissionsResult(call: PluginCall?, result: ActivityResult) {
        val granted = contract.parseResult(result.resultCode, result.data)
        if (granted.containsAll(permissions)) call?.resolve(JSObject().put("granted", true)) else call?.reject("Steps and Speed read permissions are required.")
    }
    @PluginMethod fun startMonitoring(call: PluginCall) {
        scope.launch {
            try {
                if (!available() || !client().permissionController.getGrantedPermissions().containsAll(permissions)) { call.reject("Request Health Connect permissions first."); return@launch }
                since = Instant.now().minusSeconds(86400); monitoring = true; call.resolve()
            } catch (e: Exception) { call.reject(e.message, e) }
        }
    }
    @PluginMethod fun stopMonitoring(call: PluginCall) { monitoring = false; call.resolve() }
    @PluginMethod fun readSamples(call: PluginCall) {
        if (!monitoring) { call.resolve(JSObject().put("samples", JSONArray())); return }
        scope.launch {
            try {
                val until = Instant.now(); val rows = mutableListOf<JSObject>(); var page: String? = null
                do {
                    val result = client().readRecords(ReadRecordsRequest(SpeedRecord::class, TimeRangeFilter.between(since, until), pageSize = 500, pageToken = page))
                    for (record in result.records) for ((i, sample) in record.samples.withIndex()) {
                        rows.add(JSObject().put("id", "${record.metadata.id}:speed:$i").put("metric", "speed").put("value", sample.speed.inMetersPerSecond).put("start", sample.time.toEpochMilli() / 1000.0).put("end", sample.time.toEpochMilli() / 1000.0).put("source", "health_connect"))
                    }
                    page = result.pageToken
                } while (!page.isNullOrEmpty() && rows.size < 5000)
                page = null
                do {
                    val result = client().readRecords(ReadRecordsRequest(StepsRecord::class, TimeRangeFilter.between(since, until), pageSize = 500, pageToken = page))
                    for (record in result.records) rows.add(JSObject().put("id", "${record.metadata.id}:steps").put("metric", "steps").put("value", record.count.toDouble()).put("start", record.startTime.toEpochMilli() / 1000.0).put("end", record.endTime.toEpochMilli() / 1000.0).put("source", "health_connect"))
                    page = result.pageToken
                } while (!page.isNullOrEmpty() && rows.size < 6000)
                since = until.minusSeconds(120) // Catch delayed writes; the JS analyzer deduplicates record IDs.
                call.resolve(JSObject().put("samples", JSONArray(rows)))
            } catch (e: Exception) { call.reject(e.message, e) }
        }
    }
    override fun handleOnDestroy() { motionRequested = false; endMotion(); monitoring = false; scope.cancel(); super.handleOnDestroy() }
}
