package ly.shahboun.voiceprobe;

interface IProbeService {
    int getRemoteUid();
    String testDefaultEffect(String typeUuid, String implementationUuid, int source);
    void destroy();
}
