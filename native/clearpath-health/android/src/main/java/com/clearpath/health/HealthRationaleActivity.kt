package com.clearpath.health
import android.app.Activity
import android.os.Bundle
import android.widget.TextView
class HealthRationaleActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(TextView(this).apply { text = "ClearPath reads steps and walking speed to identify changes in terrain. Raw health measurements stay on this phone. Only fresh derived hazards matched to a contemporaneous location are sent to your paired observer. You can revoke access in Health Connect or tap Stop sharing."; textSize = 18f; setPadding(32,64,32,32) })
    }
}
