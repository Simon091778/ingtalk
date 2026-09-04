package kr.ingtalk.phonehint

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.google.android.gms.auth.api.identity.GetPhoneNumberHintIntentRequest
import com.google.android.gms.auth.api.identity.Identity

// The system picker discloses only the number the user selects. This is a hint,
// not verification. No contacts, phone-state or SMS-reading permissions are used.
class PhoneNumberHintModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), LifecycleEventListener {
  private var pending: Promise? = null
  private var requestActivity: Activity? = null
  @Volatile private var invalidated = false

  private val activityListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode != REQUEST_CODE || activity !== requestActivity) return
      val promise = pending ?: return
      val number = if (resultCode == Activity.RESULT_OK && data != null && !invalidated) {
        try { Identity.getSignInClient(activity).getPhoneNumberFromIntent(data) }
        catch (_: Exception) { null }
      } else null
      finish(promise, number)
    }
  }

  init {
    context.addActivityEventListener(activityListener)
    context.addLifecycleEventListener(this)
  }

  override fun getName() = "IngtalkPhoneNumberHint"

  private fun finish(promise: Promise, number: String? = null) {
    if (pending !== promise) return
    pending = null
    requestActivity = null
    promise.resolve(number)
  }

  @ReactMethod
  fun requestPhoneNumber(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val activity = context.currentActivity
      if (invalidated || pending != null || activity == null || activity.isFinishing || activity.isDestroyed) {
        promise.resolve(null)
        return@runOnUiThread
      }
      pending = promise
      requestActivity = activity
      try {
        val request = GetPhoneNumberHintIntentRequest.builder().build()
        Identity.getSignInClient(activity).getPhoneNumberHintIntent(request)
          .addOnSuccessListener { intent ->
            if (pending !== promise || invalidated) return@addOnSuccessListener
            if (context.currentActivity !== activity || activity.isFinishing || activity.isDestroyed) {
              finish(promise)
              return@addOnSuccessListener
            }
            try {
              activity.startIntentSenderForResult(intent.intentSender, REQUEST_CODE, null, 0, 0, 0)
            } catch (_: Exception) { finish(promise) }
          }
          .addOnFailureListener { finish(promise) }
          .addOnCanceledListener { finish(promise) }
      } catch (_: Exception) { finish(promise) }
    }
  }

  override fun onHostResume() = Unit
  override fun onHostPause() = Unit
  override fun onHostDestroy() { pending?.let { finish(it) } }

  override fun invalidate() {
    invalidated = true
    UiThreadUtil.runOnUiThread {
      pending?.let { finish(it) }
      context.removeActivityEventListener(activityListener)
      context.removeLifecycleEventListener(this)
    }
    super.invalidate()
  }

  companion object { private const val REQUEST_CODE = 0x4974 }
}
