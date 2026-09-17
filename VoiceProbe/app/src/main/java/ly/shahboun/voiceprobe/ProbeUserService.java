package ly.shahboun.voiceprobe;

import android.system.Os;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.UUID;

public class ProbeUserService extends IProbeService.Stub {

    public ProbeUserService() {
    }

    @Override
    public int getRemoteUid() {
        return Os.getuid();
    }

    @Override
    public String testDefaultEffect(String typeUuid, String implementationUuid, int source) {
        Object effect = null;
        try {
            Class<?> clazz = Class.forName("android.media.audiofx.SourceDefaultEffect");
            Constructor<?> ctor = clazz.getDeclaredConstructor(
                    UUID.class, UUID.class, int.class, int.class);
            ctor.setAccessible(true);

            UUID type = UUID.fromString(typeUuid);
            UUID implementation = UUID.fromString(implementationUuid);
            effect = ctor.newInstance(type, implementation, 0, source);

            Method release = clazz.getMethod("release");
            release.invoke(effect);
            effect = null;
            return "SUCCESS";
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            return "FAIL: " + cause.getClass().getSimpleName() + ": " + safeMessage(cause);
        } catch (Throwable e) {
            return "FAIL: " + e.getClass().getSimpleName() + ": " + safeMessage(e);
        } finally {
            if (effect != null) {
                try {
                    Method release = effect.getClass().getMethod("release");
                    release.invoke(effect);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static String safeMessage(Throwable t) {
        String message = t.getMessage();
        return message == null ? "no message" : message;
    }

    @Override
    public void destroy() {
        System.exit(0);
    }
}
