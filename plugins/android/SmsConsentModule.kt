package kr.ingtalk.phonehint

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status

// Only Google Play services may notify this receiver. The user's consent dialog
// grants access to one SMS, not the inbox. Only the code crosses the JS bridge.
class SmsConsentModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {
  private var requestId: String? = null
  private var receiver: BroadcastReceiver? = null
  private var consentIntent: Intent? = null
  private var consentActivity: Activity? = null
  private var consentRequestCode = -1
  private val handler = Handler(Looper.getMainLooper())
  private val timeout = Runnable { finish(null) }
  @Volatile private var invalidated = false

  private val activityListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestId == null || requestCode != consentRequestCode || activity !== consentActivity) return
      val code = try {
        if (resultCode == Activity.RESULT_OK && !invalidated) extractCode(data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE)) else null
      } catch (_: Exception) { null }
      finish(code)
    }
  }

  init {
    context.addActivityEventListener(activityListener)
    context.addLifecycleEventListener(this)
  }

  override fun getName() = "IngtalkSmsConsent"
  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Double) = Unit

  private fun unregister() {
    receiver?.let { try { context.unregisterReceiver(it) } catch (_: Exception) { } }
    receiver = null
  }

  private fun clear() {
    requestId = null
    handler.removeCallbacks(timeout)
    unregister()
    consentIntent = null
    consentActivity = null
    consentRequestCode = -1
  }

  private fun finish(code: String?) {
    val id = requestId ?: return
    clear()
    if (invalidated) return
    val payload = Arguments.createMap().apply {
      putString("requestId", id)
      putString("code", code)
    }
    try {
      if (context.hasActiveReactInstance()) {
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("IngtalkSmsConsentResult", payload)
      }
    } catch (_: Exception) { /* No SMS content or native exceptions in logs. */ }
  }

  private fun launchConsent() {
    if (requestId == null || invalidated || context.lifecycleState != LifecycleState.RESUMED) return
    val intent = consentIntent ?: return
    val activity = context.currentActivity ?: return
    if (activity.isFinishing || activity.isDestroyed) { finish(null); return }
    consentIntent = null
    consentActivity = activity
    // Distinct request codes prevent a result from an older attempt being used.
    nextRequestCode = if (nextRequestCode >= 0x6fff) 0x6000 else nextRequestCode + 1
    consentRequestCode = nextRequestCode
    try { activity.startActivityForResult(intent, consentRequestCode) }
    catch (_: Exception) { finish(null) }
  }

  @ReactMethod
  fun startListening(id: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      clear()
      if (invalidated || context.currentActivity == null || id.isBlank() || id.length > 100) {
        promise.resolve(false)
        return@runOnUiThread
      }
      requestId = id
      val incoming = object : BroadcastReceiver() {
        override fun onReceive(unused: Context?, intent: Intent?) {
          if (requestId != id || intent?.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
          val status = intent.extras?.get(SmsRetriever.EXTRA_STATUS) as? Status
          if (status?.statusCode != CommonStatusCodes.SUCCESS) { finish(null); return }
          consentIntent = intent.getParcelableExtra<Intent>(SmsRetriever.EXTRA_CONSENT_INTENT)
          unregister()
          if (consentIntent == null) finish(null) else launchConsent()
        }
      }
      receiver = incoming
      try {
        ContextCompat.registerReceiver(context, incoming, IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
          SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED)
        handler.postDelayed(timeout, 5 * 60 * 1000L)
        // Twilio sender numbers can vary. The dialog lets the user approve the
        // specific message; server-side OTP validation remains mandatory.
        SmsRetriever.getClient(context).startSmsUserConsent(null)
          .addOnSuccessListener { promise.resolve(requestId == id && !invalidated) }
          .addOnFailureListener { if (requestId == id) clear(); promise.resolve(false) }
          .addOnCanceledListener { if (requestId == id) clear(); promise.resolve(false) }
      } catch (_: Exception) {
        if (requestId == id) clear()
        promise.resolve(false)
      }
    }
  }

  @ReactMethod
  fun stopListening(id: String) {
    UiThreadUtil.runOnUiThread { if (requestId == id) clear() }
  }

  override fun onHostResume() { launchConsent() }
  override fun onHostPause() = Unit
  override fun onHostDestroy() { finish(null) }
  override fun invalidate() {
    invalidated = true
    UiThreadUtil.runOnUiThread {
      clear()
      context.removeActivityEventListener(activityListener)
      context.removeLifecycleEventListener(this)
    }
    super.invalidate()
  }

  companion object {
    private var nextRequestCode = 0x6000
    fun extractCode(message: String?): String? {
      if (message == null) return null
      val codes = Regex("(?<![0-9])[0-9]{6}(?![0-9])").findAll(message).map { it.value }.distinct().toList()
      return codes.singleOrNull()
    }
  }
}
