package dev.crsmith.sidetone

import android.content.ComponentName
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/** The keyboard shrinks the screen from the bottom; the top stays below the status bar. */
@RunWith(RobolectricTestRunner::class)
class KeyboardTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun theKeyboardLeavesTheTopBelowTheStatusBar() {
        lateinit var view: View
        compose.setContent {
            view = LocalView.current
            Frame { Box(Modifier.fillMaxSize().testTag("content")) }
        }
        val density = view.resources.displayMetrics.density
        val statusBar = 24
        val keyboard = 300
        compose.runOnIdle {
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, (statusBar * density).toInt(), 0, 0))
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, (keyboard * density).toInt()))
                .build()
            ViewCompat.dispatchApplyWindowInsets(view, insets)
        }

        val root = compose.onRoot().getBoundsInRoot()
        val content = compose.onNodeWithTag("content").getBoundsInRoot()
        // the frame adds 16 dp inside the insets
        assertEquals((statusBar + 16).dp.value, content.top.value, 1f)
        assertEquals((root.bottom - (keyboard + 16).dp).value, content.bottom.value, 1f)
    }

    /** Without adjustResize the window pans up over the status bar as well. */
    @Test
    fun theWindowResizesForTheKeyboard() {
        val app = RuntimeEnvironment.getApplication()
        val info = app.packageManager.getActivityInfo(ComponentName(app, MainActivity::class.java), 0)
        assertEquals(
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE,
            info.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST,
        )
    }
}
